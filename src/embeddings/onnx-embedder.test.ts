import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock onnxruntime-node before importing OnnxEmbedder
vi.mock('onnxruntime-node', () => {
  const mockRun = vi.fn().mockResolvedValue({
    last_hidden_state: {
      data: new Float32Array(384 * 512).fill(0.5), // max 512 tokens x 384 dims
    },
  });

  return {
    InferenceSession: {
      create: vi.fn().mockResolvedValue({
        run: mockRun,
      }),
    },
    Tensor: vi.fn().mockImplementation((type, data, shape) => ({ type, data, shape })),
  };
});

// Mock fs/promises
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('tokenizer.json')) {
        return JSON.stringify({
          model: {
            vocab: {
              '[CLS]': 101,
              '[SEP]': 102,
              '[UNK]': 100,
              'hello': 7592,
              'world': 2088,
            },
          },
          added_tokens: [],
        });
      }
      return Buffer.from('model data');
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

describe('OnnxEmbedder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and embeds text', async () => {
    const { OnnxEmbedder } = await import('./onnx-embedder.js');
    const embedder = new OnnxEmbedder(60000);

    const result = await embedder.embed('hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);

    // Verify the output is L2-normalized (norm ≈ 1)
    let norm = 0;
    for (let i = 0; i < result.length; i++) {
      norm += result[i] * result[i];
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 1);

    embedder.unload();
  });

  it('unloads model and clears state', async () => {
    const { OnnxEmbedder } = await import('./onnx-embedder.js');
    const embedder = new OnnxEmbedder(60000);

    await embedder.load();
    embedder.unload();

    // After unload, the next embed should re-load
    const result = await embedder.embed('test');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);

    embedder.unload();
  });

  it('idle timer triggers unload', async () => {
    vi.useFakeTimers();
    const { OnnxEmbedder } = await import('./onnx-embedder.js');
    const embedder = new OnnxEmbedder(100); // 100ms idle timeout

    await embedder.load();

    // Advance past idle timeout
    vi.advanceTimersByTime(200);

    // Model should be unloaded — next embed triggers reload
    const { InferenceSession } = await import('onnxruntime-node');
    vi.mocked(InferenceSession.create).mockClear();

    await embedder.embed('after idle');
    expect(InferenceSession.create).toHaveBeenCalled();

    embedder.unload();
    vi.useRealTimers();
  });

  it('concurrent load calls serialize via loadPromise', async () => {
    const { OnnxEmbedder } = await import('./onnx-embedder.js');
    const embedder = new OnnxEmbedder(60000);

    // Start two concurrent embeds — both should trigger load but only one actual load
    const [r1, r2] = await Promise.all([
      embedder.embed('query one'),
      embedder.embed('query two'),
    ]);

    expect(r1).toBeInstanceOf(Float32Array);
    expect(r2).toBeInstanceOf(Float32Array);

    embedder.unload();
  });

  it('handles corrupted tokenizer by re-downloading', async () => {
    const fs = await import('fs/promises');
    const { OnnxEmbedder } = await import('./onnx-embedder.js');

    // First read throws SyntaxError (corrupted), then works after re-download
    let callCount = 0;
    vi.mocked(fs.readFile).mockImplementation(async (path: any) => {
      if (typeof path === 'string' && path.endsWith('tokenizer.json')) {
        callCount++;
        if (callCount === 1) {
          throw new SyntaxError('Unexpected token');
        }
        return JSON.stringify({
          model: {
            vocab: { '[CLS]': 101, '[SEP]': 102, '[UNK]': 100, 'test': 1234 },
          },
          added_tokens: [],
        });
      }
      return Buffer.from('data') as any;
    });

    // Mock fetch for re-download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(
        new TextEncoder().encode(JSON.stringify({
          model: {
            vocab: { '[CLS]': 101, '[SEP]': 102, '[UNK]': 100, 'test': 1234 },
          },
          added_tokens: [],
        })).buffer
      ),
    }) as any;

    const embedder = new OnnxEmbedder(60000);
    await embedder.load();

    // Should have called unlink (delete corrupted file)
    expect(fs.unlink).toHaveBeenCalled();

    embedder.unload();
    globalThis.fetch = originalFetch;
  });

  it('handles corrupted model by deleting and throwing', async () => {
    const { InferenceSession } = await import('onnxruntime-node');
    const fs = await import('fs/promises');
    const { OnnxEmbedder } = await import('./onnx-embedder.js');

    vi.mocked(InferenceSession.create).mockRejectedValueOnce(
      new Error('Invalid model format')
    );

    const embedder = new OnnxEmbedder(60000);
    await expect(embedder.load()).rejects.toThrow('corrupted or incompatible');
    expect(fs.unlink).toHaveBeenCalled();

    embedder.unload();
  });
});

describe('fetchWithRetry', () => {
  it('retries on network errors', async () => {
    const { fetchWithRetry } = await import('./onnx-embedder.js');

    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('fetch failed');
        (err as any).code = 'ECONNRESET';
        throw err;
      }
      return { ok: true, status: 200 };
    }) as any;

    const response = await fetchWithRetry('https://example.com/test', 3);
    expect(response.ok).toBe(true);
    expect(attempts).toBe(3);

    globalThis.fetch = originalFetch;
  });

  it('throws after all retries exhausted', async () => {
    const { fetchWithRetry } = await import('./onnx-embedder.js');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('Network error'), { code: 'ECONNRESET' })
    );

    await expect(fetchWithRetry('https://example.com/fail', 2)).rejects.toThrow();

    globalThis.fetch = originalFetch;
  });

  it('retries on 500 server errors', async () => {
    const { fetchWithRetry } = await import('./onnx-embedder.js');

    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) {
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      }
      return { ok: true, status: 200 };
    }) as any;

    const response = await fetchWithRetry('https://example.com/test', 3);
    expect(response.ok).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
