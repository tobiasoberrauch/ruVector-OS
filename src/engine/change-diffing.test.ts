import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Indexer } from './indexer.js';
import { Chunker } from './chunker.js';
import { ContentExtractor } from './content-extractor.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IndexedFile, StoredChunk } from '../shared/types.js';
import { contentHash, fileId } from '../shared/utils.js';

const testRoot = join(tmpdir(), 'ruvector-change-diffing-test');

const fakeVector = new Float32Array(384).fill(0.1);

function createMockVectorStore() {
  const store = new Map<string, { vector: Float32Array; metadata: Record<string, unknown> }>();
  return {
    upsert: vi.fn().mockImplementation(async (id: string, vector: Float32Array, metadata: Record<string, unknown>) => {
      store.set(id, { vector, metadata });
    }),
    delete: vi.fn().mockImplementation(async (id: string) => {
      const existed = store.has(id);
      store.delete(id);
      return existed;
    }),
    deleteByPrefix: vi.fn().mockImplementation(async (fId: string) => {
      let deleted = 0;
      for (const key of [...store.keys()]) {
        if (key === fId || key.startsWith(fId + ':')) {
          store.delete(key);
          deleted++;
        }
      }
      return deleted;
    }),
    upsertChunks: vi.fn().mockImplementation(async (fId: string, chunks: Array<{ index: number; vector: Float32Array; metadata: Record<string, unknown> }>) => {
      for (const chunk of chunks) {
        store.set(`${fId}:${chunk.index}`, { vector: chunk.vector, metadata: chunk.metadata });
      }
    }),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockImplementation(async () => store.size),
    init: vi.fn().mockResolvedValue(undefined),
    _store: store, // expose for assertions
  };
}

function createMockMetadataDb() {
  const files = new Map<string, IndexedFile>();
  const chunks = new Map<string, StoredChunk[]>();

  return {
    getFileByPath: vi.fn((path: string) => {
      for (const f of files.values()) if (f.path === path) return f;
      return null;
    }),
    upsertFile: vi.fn((file: IndexedFile) => { files.set(file.id, file); }),
    deleteFileByPath: vi.fn(),
    getFile: vi.fn(),
    setFileMetadataBulk: vi.fn(),
    clearFileMetadata: vi.fn(),
    getFileChunks: vi.fn((fId: string) => chunks.get(fId) ?? []),
    upsertFileChunks: vi.fn((fId: string, newChunks: StoredChunk[]) => {
      chunks.set(fId, newChunks);
    }),
    clearFileChunks: vi.fn(),
    _files: files,
    _chunks: chunks,
  };
}

function createMockGraph() {
  return {
    addFileNode: vi.fn().mockResolvedValue(undefined),
    addConceptNode: vi.fn().mockResolvedValue(undefined),
    connectFileToConcept: vi.fn().mockResolvedValue(undefined),
    removeFileNode: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedder() {
  return {
    embed: vi.fn().mockResolvedValue(fakeVector),
    isModelDownloaded: vi.fn().mockResolvedValue(true),
    downloadModel: vi.fn(),
    unload: vi.fn(),
  };
}

describe('Change diffing (incremental re-embedding)', () => {
  let indexer: Indexer;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let metadataDb: ReturnType<typeof createMockMetadataDb>;
  let graph: ReturnType<typeof createMockGraph>;
  let embedder: ReturnType<typeof createMockEmbedder>;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(testRoot, `run-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    vectorStore = createMockVectorStore();
    metadataDb = createMockMetadataDb();
    graph = createMockGraph();
    embedder = createMockEmbedder();
    indexer = new Indexer(vectorStore as any, metadataDb as any, graph as any, embedder as any);

    // Enable chunking
    indexer.setContentExtractor(new ContentExtractor());
    indexer.setChunker(new Chunker());
  });

  afterEach(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('embeds all chunks on first index', async () => {
    // Create a file large enough to be chunked
    const content = `# Introduction\n${'Intro text. '.repeat(200)}\n\n## Details\n${'Detail text. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    // All chunks should have been embedded
    const stats = indexer.getStats();
    expect(stats.chunksEmbedded).toBeGreaterThan(0);
    expect(stats.chunksSkipped).toBe(0);
    expect(embedder.embed).toHaveBeenCalled();
  });

  it('skips unchanged chunks on re-index', async () => {
    // First index
    const content = `# Section A\n${'AAA text. '.repeat(200)}\n\n## Section B\n${'BBB text. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const firstStats = indexer.getStats();
    const firstEmbedCount = firstStats.chunksEmbedded;
    expect(firstEmbedCount).toBeGreaterThan(0);

    // Change file hash so the Indexer doesn't short-circuit at the file level
    const fId = fileId(filePath);
    metadataDb._files.get(fId)!.contentHash = 'different-hash';

    // Re-index same content — chunks should be skipped
    const embedCallsBefore = embedder.embed.mock.calls.length;
    indexer.enqueue({ type: 'change', path: filePath });
    await indexer.flush();

    const secondStats = indexer.getStats();
    expect(secondStats.chunksSkipped).toBeGreaterThan(0);
    // Should have skipped some embedding calls
    expect(secondStats.chunksEmbedded).toBe(firstEmbedCount); // No new embeddings
  });

  it('only re-embeds changed chunks when middle of file changes', async () => {
    // First index
    const content = `# Section A\n${'AAA text. '.repeat(200)}\n\n## Section B\n${'BBB text. '.repeat(200)}\n\n## Section C\n${'CCC text. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const firstEmbedCount = embedder.embed.mock.calls.length;
    const fId = fileId(filePath);

    // Change only Section B
    const changedContent = `# Section A\n${'AAA text. '.repeat(200)}\n\n## Section B\n${'CHANGED text. '.repeat(200)}\n\n## Section C\n${'CCC text. '.repeat(200)}`;
    await writeFile(filePath, changedContent);

    // Update file hash to trigger re-indexing
    metadataDb._files.get(fId)!.contentHash = 'old-hash';

    embedder.embed.mockClear();
    indexer.enqueue({ type: 'change', path: filePath });
    await indexer.flush();

    const stats = indexer.getStats();
    // Should have only embedded the changed chunk(s), not all of them
    expect(stats.chunksSkipped).toBeGreaterThan(0);
    expect(embedder.embed.mock.calls.length).toBeLessThan(firstEmbedCount);
  });

  it('deletes removed chunks when file shrinks', async () => {
    // First index with 3 sections
    const content = `# A\n${'AAA. '.repeat(200)}\n\n## B\n${'BBB. '.repeat(200)}\n\n## C\n${'CCC. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const fId = fileId(filePath);
    const storedChunkCount = metadataDb._chunks.get(fId)?.length ?? 0;
    expect(storedChunkCount).toBeGreaterThan(1);

    // Shrink file to just 1 section
    const shrunkContent = `# A\n${'AAA. '.repeat(200)}`;
    await writeFile(filePath, shrunkContent);
    metadataDb._files.get(fId)!.contentHash = 'old-hash';

    indexer.enqueue({ type: 'change', path: filePath });
    await indexer.flush();

    // Should have deleted excess chunks
    const stats = indexer.getStats();
    expect(stats.chunksDeleted).toBeGreaterThan(0);
  });

  it('adds new chunks when file grows', async () => {
    // First index with 1 section
    const content = `# A\n${'AAA. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const fId = fileId(filePath);
    const initialChunkCount = metadataDb._chunks.get(fId)?.length ?? 0;

    // Grow file to 3 sections
    const grownContent = `# A\n${'AAA. '.repeat(200)}\n\n## B\n${'BBB. '.repeat(200)}\n\n## C\n${'CCC. '.repeat(200)}`;
    await writeFile(filePath, grownContent);
    metadataDb._files.get(fId)!.contentHash = 'old-hash';

    embedder.embed.mockClear();
    indexer.enqueue({ type: 'change', path: filePath });
    await indexer.flush();

    const newChunkCount = metadataDb._chunks.get(fId)?.length ?? 0;
    expect(newChunkCount).toBeGreaterThan(initialChunkCount);
  });

  it('re-embeds everything on complete rewrite', async () => {
    // First index
    const content = `# A\n${'AAA. '.repeat(200)}\n\n## B\n${'BBB. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const firstEmbedCount = embedder.embed.mock.calls.length;
    const fId = fileId(filePath);

    // Complete rewrite with different content
    const newContent = `# X\n${'XXX. '.repeat(200)}\n\n## Y\n${'YYY. '.repeat(200)}`;
    await writeFile(filePath, newContent);
    metadataDb._files.get(fId)!.contentHash = 'old-hash';

    embedder.embed.mockClear();
    indexer.enqueue({ type: 'change', path: filePath });
    await indexer.flush();

    // All chunks should have been re-embedded
    const stats = indexer.getStats();
    expect(stats.chunksSkipped).toBe(0); // No skips on the second pass
    expect(embedder.embed.mock.calls.length).toBeGreaterThan(0);
  });

  it('tracks chunk stats correctly', async () => {
    const content = `# A\n${'AAA. '.repeat(200)}\n\n## B\n${'BBB. '.repeat(200)}`;
    const filePath = join(testDir, 'doc.md');
    await writeFile(filePath, content);

    indexer.enqueue({ type: 'add', path: filePath });
    await indexer.flush();

    const stats = indexer.getStats();
    expect(typeof stats.chunksEmbedded).toBe('number');
    expect(typeof stats.chunksSkipped).toBe('number');
    expect(typeof stats.chunksDeleted).toBe('number');
    expect(stats.chunksEmbedded).toBeGreaterThan(0);
  });
});
