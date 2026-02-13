import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Indexer } from './indexer.js';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IndexedFile, WatcherEvent } from '../shared/types.js';

// ── Mocks ──────────────────────────────────────────────────

const fakeVector = new Float32Array(384).fill(0.1);
const testDir = join(tmpdir(), 'ruvector-indexer-test-' + Date.now());

function createMockVectorStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    init: vi.fn().mockResolvedValue(undefined),
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    deleteByPrefix: vi.fn().mockResolvedValue(0),
  };
}

function createMockMetadataDb() {
  const files = new Map<string, IndexedFile>();
  return {
    getFileByPath: vi.fn((path: string) => {
      for (const f of files.values()) if (f.path === path) return f;
      return null;
    }),
    upsertFile: vi.fn((file: IndexedFile) => { files.set(file.id, file); }),
    deleteFileByPath: vi.fn((path: string) => {
      for (const [id, f] of files) if (f.path === path) files.delete(id);
    }),
    getFile: vi.fn(),
    setFileMetadataBulk: vi.fn(),
    clearFileMetadata: vi.fn(),
    getFileChunks: vi.fn().mockReturnValue([]),
    upsertFileChunks: vi.fn(),
    clearFileChunks: vi.fn(),
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

// ── Helpers ────────────────────────────────────────────────

async function createTestFile(name: string, content: string): Promise<string> {
  const path = join(testDir, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

function waitForEvent(indexer: Indexer, event: string, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    indexer.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

// ── Tests ──────────────────────────────────────────────────

describe('Indexer', () => {
  let indexer: Indexer;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let metadataDb: ReturnType<typeof createMockMetadataDb>;
  let graph: ReturnType<typeof createMockGraph>;
  let embedder: ReturnType<typeof createMockEmbedder>;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    vectorStore = createMockVectorStore();
    metadataDb = createMockMetadataDb();
    graph = createMockGraph();
    embedder = createMockEmbedder();
    indexer = new Indexer(vectorStore as any, metadataDb as any, graph as any, embedder as any);
  });

  afterEach(async () => {
    try {
      const { readdirSync, unlinkSync, rmdirSync } = await import('fs');
      for (const f of readdirSync(testDir)) unlinkSync(join(testDir, f));
      rmdirSync(testDir);
    } catch {}
  });

  describe('file add events', () => {
    it('indexes a new file through the full pipeline', async () => {
      const filePath = await createTestFile('hello.ts', 'export const greeting = "hello";');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      const record = await indexed;

      expect(record.name).toBe('hello.ts');
      expect(record.extension).toBe('.ts');
      expect(embedder.embed).toHaveBeenCalled();
      expect(vectorStore.upsert).toHaveBeenCalledWith(
        expect.any(String),
        fakeVector,
        expect.objectContaining({ path: filePath, name: 'hello.ts' }),
      );
      expect(metadataDb.upsertFile).toHaveBeenCalled();
      expect(graph.addFileNode).toHaveBeenCalled();
    });

    it('extracts concepts from filename', async () => {
      const filePath = await createTestFile('authService.ts', 'class AuthService {}');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      await indexed;

      // Should extract concepts like "auth", "service", "typescript"
      expect(graph.addConceptNode).toHaveBeenCalled();
      expect(graph.connectFileToConcept).toHaveBeenCalled();
    });

    it('skips empty files', async () => {
      const filePath = await createTestFile('empty.ts', '');

      indexer.enqueue({ type: 'add', path: filePath });
      await indexer.flush();

      expect(embedder.embed).not.toHaveBeenCalled();
    });

    it('skips unchanged files (hash match)', async () => {
      const filePath = await createTestFile('same.ts', 'const same = true;');

      // Pre-populate metadata with matching content hash
      const { contentHash, fileId } = await import('../shared/utils.js');
      const hash = contentHash('const same = true;');
      metadataDb.getFileByPath.mockReturnValue({
        id: fileId(filePath),
        path: filePath,
        contentHash: hash,
      } as IndexedFile);

      indexer.enqueue({ type: 'change', path: filePath });
      await indexer.flush();

      expect(embedder.embed).not.toHaveBeenCalled();
    });

    it('re-indexes when content changes', async () => {
      const filePath = await createTestFile('changed.ts', 'const v2 = true;');

      // Pre-populate with different hash
      const { fileId } = await import('../shared/utils.js');
      metadataDb.getFileByPath.mockReturnValue({
        id: fileId(filePath),
        path: filePath,
        contentHash: 'old-hash-mismatch',
      } as IndexedFile);

      const updated = waitForEvent(indexer, 'updated');
      indexer.enqueue({ type: 'change', path: filePath });
      await updated;

      expect(embedder.embed).toHaveBeenCalled();
      expect(vectorStore.upsert).toHaveBeenCalled();
    });
  });

  describe('file delete events', () => {
    it('removes file from all stores on unlink', async () => {
      const filePath = '/project/deleted-file.ts';
      const { fileId } = await import('../shared/utils.js');
      const id = fileId(filePath);

      const deleted = waitForEvent(indexer, 'deleted');
      indexer.enqueue({ type: 'unlink', path: filePath });
      await deleted;

      expect(metadataDb.deleteFileByPath).toHaveBeenCalledWith(filePath);
      expect(metadataDb.clearFileChunks).toHaveBeenCalledWith(id);
      expect(vectorStore.deleteByPrefix).toHaveBeenCalledWith(id);
      expect(graph.removeFileNode).toHaveBeenCalledWith(id);
    });
  });

  describe('batching', () => {
    it('processes batch of files', async () => {
      const paths = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createTestFile(`batch-${i}.ts`, `export const x${i} = ${i};`)
        )
      );

      let indexedCount = 0;
      indexer.on('indexed', () => indexedCount++);

      for (const path of paths) {
        indexer.enqueue({ type: 'add', path });
      }

      await indexer.flush();
      expect(indexedCount).toBe(5);
      expect(embedder.embed).toHaveBeenCalledTimes(5);
    });

    it('handles errors in individual files without failing the batch', async () => {
      const goodPath = await createTestFile('good.ts', 'export const x = 1;');
      const badPath = '/nonexistent/file.ts';

      let indexedCount = 0;
      indexer.on('indexed', () => indexedCount++);

      indexer.enqueue({ type: 'add', path: badPath });
      indexer.enqueue({ type: 'add', path: goodPath });
      await indexer.flush();

      expect(indexedCount).toBe(1); // Only good file indexed
    });
  });

  describe('stats', () => {
    it('tracks indexing stats', async () => {
      const filePath = await createTestFile('stats.ts', 'const s = 1;');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      await indexed;

      const stats = indexer.getStats();
      expect(stats.indexed).toBe(1);
      expect(stats.avgEmbeddingTime).toBeGreaterThanOrEqual(0);
      expect(stats.queueLength).toBe(0);
    });

    it('tracks deletion count', async () => {
      const deleted = waitForEvent(indexer, 'deleted');
      indexer.enqueue({ type: 'unlink', path: '/some/file.ts' });
      await deleted;

      const stats = indexer.getStats();
      expect(stats.deleted).toBe(1);
    });
  });

  describe('concept extraction', () => {
    it('extracts language concepts from extension', async () => {
      const filePath = await createTestFile('app.py', 'print("hello")');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      await indexed;

      // Should have called addConceptNode with 'python'
      const conceptCalls = graph.addConceptNode.mock.calls.map(c => c[1]);
      expect(conceptCalls).toContain('python');
    });

    it('extracts camelCase name parts', async () => {
      const filePath = await createTestFile('userAuthService.ts', 'class UserAuthService {}');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      await indexed;

      const conceptCalls = graph.addConceptNode.mock.calls.map(c => c[1]);
      expect(conceptCalls).toContain('user');
      expect(conceptCalls).toContain('auth');
      expect(conceptCalls).toContain('service');
    });

    it('extracts kebab-case name parts', async () => {
      const filePath = await createTestFile('api-client.ts', 'class ApiClient {}');

      const indexed = waitForEvent(indexer, 'indexed');
      indexer.enqueue({ type: 'add', path: filePath });
      await indexed;

      const conceptCalls = graph.addConceptNode.mock.calls.map(c => c[1]);
      expect(conceptCalls).toContain('api');
      expect(conceptCalls).toContain('client');
    });
  });

  describe('flush', () => {
    it('processes all queued events', async () => {
      const path1 = await createTestFile('flush1.ts', 'const a = 1;');
      const path2 = await createTestFile('flush2.ts', 'const b = 2;');

      indexer.enqueue({ type: 'add', path: path1 });
      indexer.enqueue({ type: 'add', path: path2 });

      await indexer.flush();
      expect(embedder.embed).toHaveBeenCalledTimes(2);
    });

    it('returns when queue is empty', async () => {
      await indexer.flush(); // Should not hang
    });
  });
});
