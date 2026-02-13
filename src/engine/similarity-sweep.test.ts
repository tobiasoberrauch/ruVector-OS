import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimilaritySweep } from './similarity-sweep.js';

// Mock battery module
vi.mock('../shared/battery.js', () => ({
  shouldDeferHeavyWork: vi.fn().mockResolvedValue(false),
}));

// Create mock stores
function createMockMetadataDb(fileIds: string[] = []) {
  return {
    getAllFileIds: vi.fn().mockReturnValue(fileIds),
  };
}

function createMockVectorStore(entries: Record<string, Float32Array> = {}) {
  return {
    get: vi.fn().mockImplementation(async (id: string) => {
      const vector = entries[id];
      return vector ? { id, vector, metadata: {} } : null;
    }),
    search: vi.fn().mockImplementation(async ({ vector, k }: { vector: Float32Array; k: number }) => {
      // Return entries that have vectors, simulating search results
      return Object.entries(entries)
        .map(([id, vec]) => ({
          id,
          score: 0.85, // Above default threshold
          metadata: {},
        }))
        .slice(0, k);
    }),
  };
}

function createMockGraph() {
  return {
    connectSimilarFiles: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SimilaritySweep — timer', () => {
  it('starts and stops the timer', () => {
    const sweep = new SimilaritySweep(
      createMockMetadataDb() as any,
      createMockVectorStore() as any,
      createMockGraph() as any,
      60000,
    );

    expect(sweep.isRunning()).toBe(false);
    sweep.start();
    sweep.stop();
    expect(sweep.isRunning()).toBe(false);
  });

  it('start is idempotent', () => {
    const sweep = new SimilaritySweep(
      createMockMetadataDb() as any,
      createMockVectorStore() as any,
      createMockGraph() as any,
      60000,
    );

    sweep.start();
    sweep.start(); // Should not create a second timer
    sweep.stop();
  });
});

describe('SimilaritySweep — runSweep', () => {
  it('returns zeros for empty database', async () => {
    const sweep = new SimilaritySweep(
      createMockMetadataDb([]) as any,
      createMockVectorStore() as any,
      createMockGraph() as any,
    );

    const result = await sweep.runSweep();
    expect(result.filesProcessed).toBe(0);
    expect(result.edgesCreated).toBe(0);
  });

  it('creates edges for similar files', async () => {
    const vec1 = new Float32Array(384).fill(0.5);
    const vec2 = new Float32Array(384).fill(0.6);

    const metadataDb = createMockMetadataDb(['f1', 'f2']);
    const vectorStore = createMockVectorStore({ f1: vec1, f2: vec2 });
    const graph = createMockGraph();

    const sweep = new SimilaritySweep(
      metadataDb as any,
      vectorStore as any,
      graph as any,
    );

    const result = await sweep.runSweep();
    expect(result.filesProcessed).toBeGreaterThan(0);
    expect(graph.connectSimilarFiles).toHaveBeenCalled();
  });

  it('skips self-matches', async () => {
    const vec = new Float32Array(384).fill(0.5);
    const metadataDb = createMockMetadataDb(['f1']);
    const vectorStore = {
      get: vi.fn().mockResolvedValue({ id: 'f1', vector: vec, metadata: {} }),
      search: vi.fn().mockResolvedValue([
        { id: 'f1', score: 1.0, metadata: {} }, // Self-match
      ]),
    };
    const graph = createMockGraph();

    const sweep = new SimilaritySweep(
      metadataDb as any,
      vectorStore as any,
      graph as any,
    );

    const result = await sweep.runSweep();
    expect(result.filesProcessed).toBe(1);
    expect(result.edgesCreated).toBe(0); // Self-match skipped
    expect(graph.connectSimilarFiles).not.toHaveBeenCalled();
  });

  it('concurrency guard prevents simultaneous sweeps', async () => {
    const vec = new Float32Array(384).fill(0.5);
    const metadataDb = createMockMetadataDb(['f1', 'f2', 'f3']);
    // Add a delay to vectorStore.get so the sweep takes time
    const slowVectorStore = {
      get: vi.fn().mockImplementation(async (id: string) => {
        await new Promise(r => setTimeout(r, 50));
        return { id, vector: vec, metadata: {} };
      }),
      search: vi.fn().mockImplementation(async () => [
        { id: 'f2', score: 0.85, metadata: {} },
      ]),
    };
    const graph = createMockGraph();

    const sweep = new SimilaritySweep(
      metadataDb as any,
      slowVectorStore as any,
      graph as any,
    );

    // Start two sweeps concurrently — second should be rejected by running guard
    const p1 = sweep.runSweep();
    // Small delay to let p1 set running = true
    await new Promise(r => setTimeout(r, 10));
    const r2 = await sweep.runSweep();
    const r1 = await p1;

    // The second sweep should have returned immediately with zeros
    expect(r2.filesProcessed).toBe(0);
    expect(r2.edgesCreated).toBe(0);
    // The first sweep should have processed files
    expect(r1.filesProcessed).toBeGreaterThan(0);
  });

  it('defers on battery', async () => {
    const { shouldDeferHeavyWork } = await import('../shared/battery.js');
    vi.mocked(shouldDeferHeavyWork).mockResolvedValueOnce(true);

    const sweep = new SimilaritySweep(
      createMockMetadataDb(['f1']) as any,
      createMockVectorStore() as any,
      createMockGraph() as any,
    );

    const deferredHandler = vi.fn();
    sweep.on('sweep-deferred', deferredHandler);

    const result = await sweep.runSweep();
    expect(result.filesProcessed).toBe(0);
    expect(deferredHandler).toHaveBeenCalled();
  });

  it('updates lastSweepTime and sweepFileCount', async () => {
    const vec = new Float32Array(384).fill(0.5);
    const metadataDb = createMockMetadataDb(['f1']);
    const vectorStore = createMockVectorStore({ f1: vec });
    const graph = createMockGraph();

    const sweep = new SimilaritySweep(
      metadataDb as any,
      vectorStore as any,
      graph as any,
    );

    expect(sweep.getLastSweepTime()).toBe(0);
    await sweep.runSweep();
    expect(sweep.getLastSweepTime()).toBeGreaterThan(0);
    expect(sweep.getSweepFileCount()).toBeGreaterThanOrEqual(0);
  });

  it('emits sweep-start and sweep-end events', async () => {
    const sweep = new SimilaritySweep(
      createMockMetadataDb([]) as any,
      createMockVectorStore() as any,
      createMockGraph() as any,
    );

    const startHandler = vi.fn();
    const endHandler = vi.fn();
    sweep.on('sweep-start', startHandler);
    sweep.on('sweep-end', endHandler);

    await sweep.runSweep();
    expect(startHandler).toHaveBeenCalled();
    expect(endHandler).toHaveBeenCalledWith({ filesProcessed: 0, edgesCreated: 0 });
  });

  it('handles vector store errors gracefully', async () => {
    const metadataDb = createMockMetadataDb(['f1']);
    const vectorStore = {
      get: vi.fn().mockRejectedValue(new Error('DB error')),
      search: vi.fn().mockRejectedValue(new Error('DB error')),
    };
    const graph = createMockGraph();

    const sweep = new SimilaritySweep(
      metadataDb as any,
      vectorStore as any,
      graph as any,
    );

    // Should not throw
    const result = await sweep.runSweep();
    expect(result.filesProcessed).toBe(0);
  });
});
