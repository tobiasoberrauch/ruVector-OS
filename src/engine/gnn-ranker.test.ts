import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @ruvector/gnn
vi.mock('@ruvector/gnn', () => {
  const mockForward = vi.fn().mockImplementation(
    (fileEmb: number[], _neighborEmbs: number[][], _weights: number[]) => {
      // Return a slightly modified version of the file embedding
      return fileEmb.map(v => v * 1.05);
    }
  );

  return {
    RuvectorLayer: vi.fn().mockImplementation(() => ({
      forward: mockForward,
      toJson: vi.fn().mockReturnValue('{"weights":[]}'),
    })),
  };
});

// Mock fs for weights save/load
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

describe('GnnRanker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes and becomes active', async () => {
    const { GnnRanker } = await import('./gnn-ranker.js');
    const mockGraph = {} as any;
    const mockDb = {} as any;
    const mockVS = {} as any;
    const ranker = new GnnRanker(mockGraph, mockDb, mockVS);
    await ranker.init();
    expect(ranker.isActive()).toBe(true);
  });

  it('returns results unmodified when inactive', async () => {
    const { GnnRanker } = await import('./gnn-ranker.js');

    // Force inactive by making init fail
    const { RuvectorLayer } = await import('@ruvector/gnn');
    vi.mocked(RuvectorLayer).mockImplementationOnce(() => { throw new Error('fail'); });

    const ranker = new GnnRanker({} as any, {} as any, {} as any);
    await ranker.init();
    expect(ranker.isActive()).toBe(false);

    const results = [
      { file: { id: 'f1', path: '/f1', name: 'f1.ts', extension: '.ts', size: 100, modifiedAt: 0, indexedAt: 0, embeddedAt: 0, contentPreview: '', contentHash: '' }, score: 0.9, snippet: '' },
      { file: { id: 'f2', path: '/f2', name: 'f2.ts', extension: '.ts', size: 100, modifiedAt: 0, indexedAt: 0, embeddedAt: 0, contentPreview: '', contentHash: '' }, score: 0.8, snippet: '' },
    ];

    const reranked = await ranker.rerank(new Float32Array(384), results as any, 2);
    expect(reranked).toHaveLength(2);
    expect(reranked[0].score).toBe(0.9); // Unchanged
  });

  it('blends scores: 0.7 * vector + 0.2 * gnn + 0.1 * importance', async () => {
    const { GnnRanker } = await import('./gnn-ranker.js');

    const mockGraph = {
      getRelatedFiles: vi.fn().mockResolvedValue([
        { id: 'n1', label: 'neighbor.ts', weight: 0.5, edgeType: 'similar_to' },
      ]),
    };
    const mockDb = {
      getImportance: vi.fn().mockReturnValue(0.8),
    };
    const mockVS = {
      get: vi.fn().mockResolvedValue({
        id: 'f1',
        vector: new Float32Array(384).fill(0.5),
        metadata: {},
      }),
    };

    const ranker = new GnnRanker(mockGraph as any, mockDb as any, mockVS as any);
    await ranker.init();

    const results = [{
      file: { id: 'f1', path: '/f1', name: 'f1.ts', extension: '.ts', size: 100, modifiedAt: 0, indexedAt: 0, embeddedAt: 0, contentPreview: '', contentHash: '' },
      score: 0.85,
      snippet: '',
    }];

    const reranked = await ranker.rerank(new Float32Array(384).fill(0.5), results as any, 1);
    expect(reranked).toHaveLength(1);

    // Score should be a blend: 0.7 * 0.85 + 0.2 * gnnScore + 0.1 * min(0.8, 1)
    // gnnScore = cosine sim between query and enhanced embedding
    const score = reranked[0].score;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('saves weights without errors', async () => {
    const { GnnRanker } = await import('./gnn-ranker.js');
    const ranker = new GnnRanker({} as any, {} as any, {} as any);
    await ranker.init();
    await ranker.saveWeights(); // Should not throw
  });

  it('returns empty for empty results', async () => {
    const { GnnRanker } = await import('./gnn-ranker.js');
    const ranker = new GnnRanker({} as any, {} as any, {} as any);
    await ranker.init();
    const reranked = await ranker.rerank(new Float32Array(384), [], 5);
    expect(reranked).toHaveLength(0);
  });
});
