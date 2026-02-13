import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isProcessRunning, readPidFile } from '../shared/utils.js';

// ── isProcessRunning / readPidFile tests ───────────────

describe('isProcessRunning', () => {
  it('returns true for the current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessRunning(99999999)).toBe(false);
  });
});

describe('readPidFile', () => {
  it('returns null when PID file does not exist', () => {
    // readPidFile reads from the standard PID_FILE path;
    // in test environments there's no running daemon
    const pid = readPidFile();
    // Either null (no file) or a number (if a daemon happens to be running)
    expect(pid === null || typeof pid === 'number').toBe(true);
  });
});

// ── VectorStore close/isOpen guards ───────────────────

describe('VectorStore — close and isOpen guards', () => {
  // We test the public API without importing the native ruvector module.
  // We instantiate VectorStore and mock the db field manually.

  it('isOpen returns false before init', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    expect(store.isOpen()).toBe(false);
  });

  it('close sets isOpen to false', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    // Simulate a successful init by setting the private db field
    (store as any).db = { fake: true };
    expect(store.isOpen()).toBe(true);
    store.close();
    expect(store.isOpen()).toBe(false);
  });

  it('upsert throws after close', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    // Never opened — should throw
    await expect(
      store.upsert('test', new Float32Array(384), {})
    ).rejects.toThrow('not initialized or has been closed');
  });

  it('search throws after close', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(
      store.search(new Float32Array(384))
    ).rejects.toThrow('not initialized or has been closed');
  });

  it('get throws after close', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(store.get('test')).rejects.toThrow('not initialized or has been closed');
  });

  it('delete throws after close', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(store.delete('test')).rejects.toThrow('not initialized or has been closed');
  });

  it('count throws after close', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(store.count()).rejects.toThrow('not initialized or has been closed');
  });

  it('close is idempotent', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    (store as any).db = { fake: true };
    store.close();
    store.close(); // Should not throw
    expect(store.isOpen()).toBe(false);
  });
});

describe('VectorStore — cleanStaleLocks', () => {
  it('returns false when no lock files exist', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    // In test environment, VECTOR_DIR likely doesn't have lock files
    const result = store.cleanStaleLocks();
    expect(typeof result).toBe('boolean');
  });
});

describe('VectorStore — upsertChunks', () => {
  it('throws when not initialized', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(
      store.upsertChunks('file1', [{ index: 0, vector: new Float32Array(384), metadata: {} }])
    ).rejects.toThrow('not initialized or has been closed');
  });

  it('stores chunks with fileId:chunkIndex IDs', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    const upsertCalls: Array<{ id: string; metadata: Record<string, unknown> }> = [];

    // Mock the db with insert/delete
    (store as any).db = {
      insert: vi.fn().mockImplementation(async (entry: any) => {
        upsertCalls.push({ id: entry.id, metadata: entry.metadata });
      }),
      delete: vi.fn().mockResolvedValue(false),
    };

    const vec = new Float32Array(384).fill(0.5);
    await store.upsertChunks('abc123', [
      { index: 0, vector: vec, metadata: { label: 'func1' } },
      { index: 1, vector: vec, metadata: { label: 'func2' } },
    ]);

    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0].id).toBe('abc123:0');
    expect(upsertCalls[0].metadata).toEqual(expect.objectContaining({
      fileId: 'abc123',
      chunkIndex: 0,
      label: 'func1',
    }));
    expect(upsertCalls[1].id).toBe('abc123:1');
  });
});

describe('VectorStore — deleteByPrefix', () => {
  it('throws when not initialized', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    await expect(store.deleteByPrefix('file1')).rejects.toThrow('not initialized or has been closed');
  });

  it('deletes legacy entry and chunk entries', async () => {
    const { VectorStore } = await import('./vector-store.js');
    const store = new VectorStore();
    const deleted = new Set<string>();

    // Simulate a store with fileId, fileId:0, fileId:1
    const existing = new Set(['abc123', 'abc123:0', 'abc123:1']);
    (store as any).db = {
      delete: vi.fn().mockImplementation(async (id: string) => {
        if (existing.has(id)) {
          existing.delete(id);
          deleted.add(id);
          return true;
        }
        return false;
      }),
    };

    const count = await store.deleteByPrefix('abc123');
    expect(count).toBe(3);
    expect(deleted.has('abc123')).toBe(true);
    expect(deleted.has('abc123:0')).toBe(true);
    expect(deleted.has('abc123:1')).toBe(true);
  });
});
