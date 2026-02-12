import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchEngine } from './search.js';
import type { IndexedFile, SearchResult } from '../shared/types.js';

// ── Mocks ──────────────────────────────────────────────────

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: 'file-001',
    path: '/project/src/index.ts',
    name: 'index.ts',
    extension: '.ts',
    size: 500,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    embeddedAt: Date.now(),
    contentPreview: 'export function main() {}',
    contentHash: 'abc123',
    ...overrides,
  };
}

const fakeVector = new Float32Array(384).fill(0.1);

function createMockVectorStore() {
  return {
    search: vi.fn().mockResolvedValue([
      { id: 'file-001', score: 0.9, metadata: {} },
      { id: 'file-002', score: 0.7, metadata: {} },
      { id: 'file-003', score: 0.4, metadata: {} },
    ]),
    get: vi.fn().mockResolvedValue({ id: 'file-001', vector: fakeVector, metadata: {} }),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    count: vi.fn().mockResolvedValue(3),
    init: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMetadataDb() {
  const files = new Map<string, IndexedFile>([
    ['file-001', makeFile({ id: 'file-001', path: '/project/src/index.ts', name: 'index.ts' })],
    ['file-002', makeFile({ id: 'file-002', path: '/project/src/utils.ts', name: 'utils.ts', extension: '.ts', modifiedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 })],
    ['file-003', makeFile({ id: 'file-003', path: '/project/docs/readme.md', name: 'readme.md', extension: '.md' })],
  ]);

  return {
    getFile: vi.fn((id: string) => files.get(id) ?? null),
    getFileByPath: vi.fn(),
    logSearchWithId: vi.fn().mockReturnValue(42),
    incrementShownCount: vi.fn(),
    getFileTags: vi.fn().mockReturnValue([]),
    recordClick: vi.fn(),
    recordContextEvent: vi.fn(),
  };
}

function createMockGraph() {
  return {
    getRelatedFiles: vi.fn().mockResolvedValue([]),
    addFileNode: vi.fn().mockResolvedValue(undefined),
    addConceptNode: vi.fn().mockResolvedValue(undefined),
    connectFileToConcept: vi.fn().mockResolvedValue(undefined),
    removeFileNode: vi.fn().mockResolvedValue(undefined),
    connectSimilarFiles: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ nodes: 0, edges: 0 }),
  };
}

function createMockEmbedder() {
  return {
    embed: vi.fn().mockResolvedValue(fakeVector),
    isModelDownloaded: vi.fn().mockResolvedValue(true),
    downloadModel: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('SearchEngine', () => {
  let engine: SearchEngine;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let metadataDb: ReturnType<typeof createMockMetadataDb>;
  let graph: ReturnType<typeof createMockGraph>;
  let embedder: ReturnType<typeof createMockEmbedder>;

  beforeEach(() => {
    vectorStore = createMockVectorStore();
    metadataDb = createMockMetadataDb();
    graph = createMockGraph();
    embedder = createMockEmbedder();
    engine = new SearchEngine(vectorStore as any, metadataDb as any, graph as any, embedder as any);
  });

  describe('search', () => {
    it('returns ranked results', async () => {
      const results = await engine.search({ query: 'main function', limit: 10, threshold: 0.3 });

      expect(results).toHaveLength(3);
      expect(results[0].file.id).toBe('file-001');
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });

    it('embeds the query text', async () => {
      await engine.search({ query: 'hello world', limit: 5, threshold: 0.3 });
      expect(embedder.embed).toHaveBeenCalledWith('hello world');
    });

    it('calls vectorStore.search with 2x limit', async () => {
      await engine.search({ query: 'test', limit: 5, threshold: 0.3 });
      expect(vectorStore.search).toHaveBeenCalledWith(fakeVector, 10, 0.3);
    });

    it('attaches searchId for click tracking', async () => {
      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(results[0].searchId).toBe(42);
      expect(metadataDb.logSearchWithId).toHaveBeenCalledWith('test', expect.any(Array));
    });

    it('increments shown counts', async () => {
      await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(metadataDb.incrementShownCount).toHaveBeenCalledWith(expect.arrayContaining(['file-001']));
    });

    it('filters by extension', async () => {
      const results = await engine.search({
        query: 'test',
        limit: 10,
        threshold: 0.3,
        extensions: ['.md'],
      });
      expect(results).toHaveLength(1);
      expect(results[0].file.extension).toBe('.md');
    });

    it('filters by directory', async () => {
      const results = await engine.search({
        query: 'test',
        limit: 10,
        threshold: 0.3,
        directory: '/project/docs',
      });
      expect(results).toHaveLength(1);
      expect(results[0].file.path).toContain('/project/docs');
    });

    it('applies recency boost to recent files', async () => {
      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      // file-001 was modified "now", file-002 was modified 30 days ago
      // file-001 should get a recency boost, file-002 should not
      const f1 = results.find(r => r.file.id === 'file-001')!;
      const f2 = results.find(r => r.file.id === 'file-002')!;
      // f1 base score 0.9 + recency boost, f2 base score 0.7 + no boost
      expect(f1.score).toBeGreaterThan(0.9);
      expect(f2.score).toBe(0.7);
    });

    it('respects limit', async () => {
      const results = await engine.search({ query: 'test', limit: 2, threshold: 0.3 });
      expect(results).toHaveLength(2);
    });

    it('skips files not in metadata DB', async () => {
      metadataDb.getFile.mockImplementation((id: string) => {
        if (id === 'file-002') return null;
        return makeFile({ id, path: `/project/${id}` });
      });

      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(results.find(r => r.file.id === 'file-002')).toBeUndefined();
    });

    it('queries graph for related files', async () => {
      await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(graph.getRelatedFiles).toHaveBeenCalled();
    });

    it('returns empty array when vector search has no results', async () => {
      vectorStore.search.mockResolvedValue([]);
      const results = await engine.search({ query: 'nothing', limit: 10, threshold: 0.3 });
      expect(results).toHaveLength(0);
    });

    it('includes tags when available', async () => {
      metadataDb.getFileTags.mockReturnValue([
        { tagId: 't1', label: 'typescript', confidence: 0.9 },
      ]);
      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(results[0].tags).toContain('typescript');
    });
  });

  describe('search with GNN re-ranking', () => {
    it('uses GNN ranker when active', async () => {
      const gnnRanker = {
        isActive: vi.fn().mockReturnValue(true),
        rerank: vi.fn().mockImplementation((_qv: Float32Array, results: SearchResult[], limit: number) =>
          results.slice(0, limit).reverse()
        ),
      };
      const learningEngine = { recordClick: vi.fn() };
      engine.setLearningComponents(learningEngine as any, gnnRanker as any);

      const results = await engine.search({ query: 'test', limit: 2, threshold: 0.3 });
      expect(gnnRanker.rerank).toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('falls back to score-sort when GNN inactive', async () => {
      const gnnRanker = {
        isActive: vi.fn().mockReturnValue(false),
        rerank: vi.fn(),
      };
      const learningEngine = { recordClick: vi.fn() };
      engine.setLearningComponents(learningEngine as any, gnnRanker as any);

      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(gnnRanker.rerank).not.toHaveBeenCalled();
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });
  });

  describe('search with context tracking', () => {
    it('applies context boost when tracker is set', async () => {
      const contextTracker = {
        getContextBoost: vi.fn().mockReturnValue(0.5),
        recordSearchResult: vi.fn(),
        recordAccess: vi.fn(),
      };
      const queryExpander = { expand: vi.fn(), combineEmbeddings: vi.fn() };
      engine.setAdaptiveComponents(queryExpander as any, contextTracker as any);

      const results = await engine.search({ query: 'test', limit: 10, threshold: 0.3 });
      expect(contextTracker.getContextBoost).toHaveBeenCalled();
      expect(contextTracker.recordSearchResult).toHaveBeenCalled();
      // All results should have context boost added
      const f1 = results.find(r => r.file.id === 'file-001')!;
      expect(f1.score).toBeGreaterThan(0.9); // base 0.9 + recency + context
    });
  });

  describe('recordClick', () => {
    it('delegates to learning engine when attached', async () => {
      const learningEngine = { recordClick: vi.fn() };
      const gnnRanker = { isActive: vi.fn().mockReturnValue(false), rerank: vi.fn() };
      engine.setLearningComponents(learningEngine as any, gnnRanker as any);

      await engine.recordClick(42, 'file-001', 0);
      expect(learningEngine.recordClick).toHaveBeenCalledWith(42, 'file-001', 0);
    });

    it('falls back to metadataDb when no learning engine', async () => {
      await engine.recordClick(42, 'file-001', 0);
      expect(metadataDb.recordClick).toHaveBeenCalledWith(42, 'file-001', 0);
    });

    it('records context access when tracker is set', async () => {
      const contextTracker = {
        getContextBoost: vi.fn(),
        recordSearchResult: vi.fn(),
        recordAccess: vi.fn(),
      };
      engine.setAdaptiveComponents({} as any, contextTracker as any);

      await engine.recordClick(42, 'file-001', 0);
      expect(contextTracker.recordAccess).toHaveBeenCalledWith('file-001');
    });
  });

  describe('quickSearch', () => {
    it('returns simplified results without graph traversal', async () => {
      const results = await engine.quickSearch('test', 5);
      expect(results).toHaveLength(3);
      expect(results[0]).toHaveProperty('file');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).not.toHaveProperty('relatedFiles');
    });

    it('filters out files missing from metadata', async () => {
      metadataDb.getFile.mockImplementation((id: string) => {
        if (id === 'file-001') return makeFile();
        return null;
      });
      const results = await engine.quickSearch('test', 5);
      expect(results).toHaveLength(1);
    });
  });
});
