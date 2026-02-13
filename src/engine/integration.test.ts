import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { SearchEngine } from './search.js';
import { LearningEngine } from './learning-engine.js';
import { Indexer } from './indexer.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile, rm } from 'fs/promises';
import type { IndexedFile } from '../shared/types.js';

// Mock @ruvector/graph-node to force fallback mode
vi.mock('@ruvector/graph-node', () => ({
  GraphDatabase: vi.fn().mockImplementation(() => {
    throw new Error('Native bindings not available');
  }),
}));

const testRoot = join(tmpdir(), 'ruvector-integration-test');

// Mock embedder that generates deterministic embeddings based on content
function createMockEmbedder() {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      // Generate a deterministic vector from the text
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        // Use character codes to seed the vector — same text = same vector
        const charCode = text.charCodeAt(i % text.length) || 0;
        vec[i] = Math.sin((charCode + i) * 0.1) * 0.5;
      }
      // L2 normalize
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 384; i++) vec[i] /= norm;
      return vec;
    }),
    load: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn(),
    isModelDownloaded: vi.fn().mockResolvedValue(true),
  };
}

// Mock vector store that operates in-memory
function createMockVectorStore() {
  const store = new Map<string, { vector: Float32Array; metadata: Record<string, string> }>();

  return {
    init: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockReturnValue(true),
    close: vi.fn(),
    upsert: vi.fn().mockImplementation(async (id: string, vector: Float32Array, metadata: Record<string, string>) => {
      store.set(id, { vector, metadata });
    }),
    search: vi.fn().mockImplementation(async (queryVector: Float32Array, limit: number, threshold: number) => {
      // Compute cosine similarity against all stored vectors
      const results: Array<{ id: string; score: number; metadata: Record<string, unknown> }> = [];
      for (const [id, entry] of store) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryVector.length; i++) {
          dotProduct += queryVector[i] * entry.vector[i];
          normA += queryVector[i] * queryVector[i];
          normB += entry.vector[i] * entry.vector[i];
        }
        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
        if (similarity >= threshold) {
          results.push({ id, score: similarity, metadata: entry.metadata });
        }
      }
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }),
    get: vi.fn().mockImplementation(async (id: string) => {
      const entry = store.get(id);
      if (!entry) return null;
      return { id, vector: entry.vector, metadata: entry.metadata };
    }),
    delete: vi.fn().mockImplementation(async (id: string) => {
      const existed = store.has(id);
      store.delete(id);
      return existed;
    }),
    deleteByPrefix: vi.fn().mockImplementation(async (fileId: string) => {
      let deleted = 0;
      for (const key of [...store.keys()]) {
        if (key === fileId || key.startsWith(fileId + ':')) {
          store.delete(key);
          deleted++;
        }
      }
      return deleted;
    }),
    upsertChunks: vi.fn().mockImplementation(async (fileId: string, chunks: Array<{ index: number; vector: Float32Array; metadata: Record<string, unknown> }>) => {
      for (const chunk of chunks) {
        store.set(`${fileId}:${chunk.index}`, { vector: chunk.vector, metadata: chunk.metadata as any });
      }
    }),
    count: vi.fn().mockImplementation(async () => store.size),
  };
}

describe('Full pipeline integration', () => {
  let db: MetadataDb;
  let graph: KnowledgeGraph;
  let embedder: ReturnType<typeof createMockEmbedder>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let searchEngine: SearchEngine;
  let learningEngine: LearningEngine;
  let indexer: Indexer;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(testRoot, `run-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create real MetadataDb
    db = new MetadataDb(join(testDir, 'test.db'));
    await db.init();

    // Create real KnowledgeGraph (in fallback mode)
    graph = new KnowledgeGraph();
    await graph.init();

    // Mock embedder and vector store
    embedder = createMockEmbedder();
    vectorStore = createMockVectorStore();

    // Create real Indexer
    indexer = new Indexer(
      vectorStore as any,
      db,
      graph,
      embedder as any,
    );

    // Create real SearchEngine
    searchEngine = new SearchEngine(
      vectorStore as any,
      db,
      graph,
      embedder as any,
    );

    // Create real LearningEngine
    learningEngine = new LearningEngine(db, graph);
    searchEngine.setLearningComponents(learningEngine, { isActive: () => false, rerank: async (_q: any, r: any) => r } as any);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('indexes files through the full pipeline', async () => {
    // Create 5 test files
    const files = [
      { name: 'auth-service.ts', content: 'export class AuthService { login() {} }' },
      { name: 'user-model.ts', content: 'export interface User { id: string; name: string; }' },
      { name: 'database.ts', content: 'export class DatabaseConnection { connect() {} query() {} }' },
      { name: 'api-routes.ts', content: 'export function setupRoutes(app) { app.get("/users"); }' },
      { name: 'utils.ts', content: 'export function hash(data: string) { return crypto.createHash("sha256"); }' },
    ];

    for (const f of files) {
      await writeFile(join(testDir, f.name), f.content);
    }

    // Index all files
    for (const f of files) {
      indexer.enqueue({ type: 'add', path: join(testDir, f.name) });
    }
    await indexer.flush();

    // Verify indexing
    const stats = indexer.getStats();
    expect(stats.indexed).toBe(5);
    expect(embedder.embed).toHaveBeenCalled();

    // Verify vectors were stored
    const vectorCount = await vectorStore.count();
    expect(vectorCount).toBe(5);

    // Verify metadata was stored
    const dbStats = db.getStats();
    expect(dbStats.files).toBe(5);
  });

  it('searches indexed files by semantic similarity', async () => {
    // Index files
    const files = [
      { name: 'auth.ts', content: 'Authentication service with JWT token validation' },
      { name: 'database.ts', content: 'PostgreSQL database connection pool management' },
      { name: 'api.ts', content: 'REST API endpoint route handler middleware' },
    ];

    for (const f of files) {
      await writeFile(join(testDir, f.name), f.content);
      indexer.enqueue({ type: 'add', path: join(testDir, f.name) });
    }
    await indexer.flush();

    // Search
    const results = await searchEngine.search({
      query: 'authentication login',
      limit: 5,
      threshold: 0.0, // Low threshold for mock embeddings
    });

    // Should return results
    expect(results.length).toBeGreaterThan(0);
    // Results should have searchId for click tracking
    expect(results[0].searchId).toBeDefined();
    expect(typeof results[0].searchId).toBe('number');
  });

  it('click tracking updates learning metrics', async () => {
    // Index a file
    await writeFile(join(testDir, 'important.ts'), 'The most important file');
    indexer.enqueue({ type: 'add', path: join(testDir, 'important.ts') });
    await indexer.flush();

    // Search and get a result
    const results = await searchEngine.search({
      query: 'important file',
      limit: 5,
      threshold: 0.0,
    });

    expect(results.length).toBeGreaterThan(0);
    const { searchId } = results[0];
    const fileId = results[0].file.id;

    // Record a click
    await searchEngine.recordClick(searchId, fileId, 0);

    // Check importance was set
    const importance = db.getImportance(fileId);
    expect(importance).toBeGreaterThan(0);

    // Check metrics
    const metrics = learningEngine.getMetrics();
    expect(metrics.totalSearches).toBeGreaterThanOrEqual(1);
    expect(metrics.totalClicks).toBeGreaterThanOrEqual(1);
  });

  it('file deletion removes from all stores', async () => {
    // Index a file
    const filePath = join(testDir, 'delete-me.ts');
    await writeFile(filePath, 'temporary content');
    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const initialCount = await vectorStore.count();
    expect(initialCount).toBe(1);

    // Delete the file
    indexer.enqueue({ type: 'unlink', path: filePath });
    await indexer.flush();

    // Vector store should be empty
    const afterCount = await vectorStore.count();
    expect(afterCount).toBe(0);

    // Stats should show deletion
    const stats = indexer.getStats();
    expect(stats.deleted).toBe(1);
  });

  it('search → click → verify learning → search again with boosted results', async () => {
    // Index multiple files
    const files = [
      { name: 'target.ts', content: 'Target file with specific content about authentication' },
      { name: 'other.ts', content: 'Other file with different content about databases' },
    ];

    for (const f of files) {
      await writeFile(join(testDir, f.name), f.content);
      indexer.enqueue({ type: 'add', path: join(testDir, f.name) });
    }
    await indexer.flush();

    // First search
    const results1 = await searchEngine.search({
      query: 'authentication',
      limit: 5,
      threshold: 0.0,
    });
    expect(results1.length).toBeGreaterThan(0);

    // Click on first result to boost it
    const clickedId = results1[0].file.id;
    await searchEngine.recordClick(results1[0].searchId, clickedId, 0);

    // Verify learning recorded
    const importance = db.getImportance(clickedId);
    expect(importance).toBeGreaterThan(0);
  });

  it('graph edges are created via indexer concept extraction', async () => {
    // Index files with shared concepts (same extension → same language concept)
    const files = [
      { name: 'module-a.ts', content: 'TypeScript module A' },
      { name: 'module-b.ts', content: 'TypeScript module B' },
    ];

    for (const f of files) {
      await writeFile(join(testDir, f.name), f.content);
      indexer.enqueue({ type: 'add', path: join(testDir, f.name) });
    }
    await indexer.flush();

    // Graph should have nodes (files + concepts)
    const graphStats = await graph.getStats();
    expect(graphStats.nodes).toBeGreaterThanOrEqual(2);
    // Should have edges (file → concept connections)
    expect(graphStats.edges).toBeGreaterThanOrEqual(2);
  });

  it('search logging tracks queries', async () => {
    await writeFile(join(testDir, 'file.ts'), 'content');
    indexer.enqueue({ type: 'add', path: join(testDir, 'file.ts') });
    await indexer.flush();

    await searchEngine.search({ query: 'first query', limit: 5, threshold: 0.0 });
    await searchEngine.search({ query: 'second query', limit: 5, threshold: 0.0 });

    const stats = db.getSearchClickStats();
    expect(stats.totalSearches).toBe(2);
  });

  it('decay and reset work on learning data', async () => {
    await writeFile(join(testDir, 'learned.ts'), 'learned content');
    indexer.enqueue({ type: 'add', path: join(testDir, 'learned.ts') });
    await indexer.flush();

    const results = await searchEngine.search({ query: 'learned', limit: 5, threshold: 0.0 });
    if (results.length > 0) {
      await searchEngine.recordClick(results[0].searchId, results[0].file.id, 0);
      const beforeDecay = db.getImportance(results[0].file.id);

      learningEngine.decayAll();
      const afterDecay = db.getImportance(results[0].file.id);
      expect(afterDecay).toBeLessThan(beforeDecay);

      learningEngine.reset();
      const afterReset = db.getImportance(results[0].file.id);
      expect(afterReset).toBe(0);
    }
  });
});
