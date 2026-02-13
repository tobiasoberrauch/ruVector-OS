import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { QueryExpander } from './query-expander.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';

const testDir = join(tmpdir(), 'ruvector-qe-test');

function createMockEmbedder() {
  let callIdx = 0;
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      // Return deterministic but different vectors for different texts
      callIdx++;
      const vec = new Float32Array(384);
      const seed = text.length + callIdx;
      for (let i = 0; i < 384; i++) {
        vec[i] = Math.sin(seed * (i + 1)) * 0.5;
      }
      // L2 normalize
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 384; i++) vec[i] /= norm;
      return vec;
    }),
  };
}

describe('QueryExpander', () => {
  let db: MetadataDb;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    db = new MetadataDb(join(testDir, `qe-${Date.now()}.db`));
    await db.init();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('returns only the original query when enough results', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    const expanded = await expander.expand('test query', 5, ['f1', 'f2']);
    expect(expanded).toEqual(['test query']);
  });

  it('expands when too few results', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    // Add some search history with clicks
    const s1 = db.logSearchWithId('related query', ['f1']);
    db.recordClick(s1, 'f1', 0);

    // Now search with insufficient results
    const expanded = await expander.expand('new query', 1, ['f1']);
    expect(expanded.length).toBeGreaterThanOrEqual(1);
    expect(expanded[0]).toBe('new query');
  });

  it('does not duplicate the original query in expansion', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    const expanded = await expander.expand('test', 0, []);
    const uniqueQueries = new Set(expanded);
    expect(uniqueQueries.size).toBe(expanded.length);
  });
});

describe('QueryExpander — combineEmbeddings', () => {
  let db: MetadataDb;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    db = new MetadataDb(join(testDir, `qe-combine-${Date.now()}.db`));
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('returns single embedding for single query', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    const result = await expander.combineEmbeddings(['single query']);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });

  it('produces weighted combination for multiple queries', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    const result = await expander.combineEmbeddings(['original', 'expansion1', 'expansion2']);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
    expect(embedder.embed).toHaveBeenCalledTimes(3);
  });

  it('output is L2-normalized', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    const result = await expander.combineEmbeddings(['q1', 'q2']);
    let norm = 0;
    for (let i = 0; i < result.length; i++) norm += result[i] * result[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 1);
  });

  it('throws on empty query list', async () => {
    const embedder = createMockEmbedder();
    const expander = new QueryExpander(db, embedder as any, {} as any);

    await expect(expander.combineEmbeddings([])).rejects.toThrow('No queries');
  });
});
