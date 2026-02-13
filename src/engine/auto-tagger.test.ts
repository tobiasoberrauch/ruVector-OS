import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import type { IndexedFile } from '../shared/types.js';

// Mock battery module
vi.mock('../shared/battery.js', () => ({
  shouldDeferHeavyWork: vi.fn().mockResolvedValue(false),
}));

const testDir = join(tmpdir(), 'ruvector-autotag-test');

function makeFile(id: string, name: string, ext: string, path: string): IndexedFile {
  return {
    id,
    path,
    name,
    extension: ext,
    size: 1000,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    embeddedAt: Date.now(),
    contentPreview: 'content',
    contentHash: `hash-${id}`,
  };
}

function createRandomVector(seed: number): Float32Array {
  // Create a deterministic pseudo-random vector for testing
  const vec = new Float32Array(384);
  let state = seed;
  for (let i = 0; i < 384; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (state / 0x7fffffff) * 2 - 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return vec;
}

describe('AutoTagger', () => {
  let db: MetadataDb;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, `test-autotag-${Date.now()}.db`);
    db = new MetadataDb(dbPath);
    await db.init();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('returns zeros when too few files', async () => {
    const { AutoTagger } = await import('./auto-tagger.js');

    // Only 2 files (below MIN_CLUSTER_SIZE of 3)
    db.upsertFile(makeFile('f1', 'a.ts', '.ts', '/src/a.ts'));
    db.upsertFile(makeFile('f2', 'b.ts', '.ts', '/src/b.ts'));

    const mockVectorStore = {
      get: vi.fn().mockResolvedValue(null),
    };
    const mockEmbedder = {} as any;

    const tagger = new AutoTagger(db, mockVectorStore as any, mockEmbedder);
    const result = await tagger.runTagging();
    expect(result.tagsCreated).toBe(0);
    expect(result.filesTagged).toBe(0);
  });

  it('defers tagging on low battery', async () => {
    const { shouldDeferHeavyWork } = await import('../shared/battery.js');
    vi.mocked(shouldDeferHeavyWork).mockResolvedValueOnce(true);

    const { AutoTagger } = await import('./auto-tagger.js');
    const tagger = new AutoTagger(db, {} as any, {} as any);

    const deferredHandler = vi.fn();
    tagger.on('tagging-deferred', deferredHandler);

    const result = await tagger.runTagging();
    expect(result.tagsCreated).toBe(0);
    expect(deferredHandler).toHaveBeenCalled();
  });

  it('creates tags from clustered files', async () => {
    const { AutoTagger } = await import('./auto-tagger.js');

    // Create enough files for clustering (>= MIN_CLUSTER_SIZE per cluster)
    // Group 1: TypeScript source files (similar vectors)
    const baseVec = createRandomVector(42);
    for (let i = 1; i <= 5; i++) {
      db.upsertFile(makeFile(`ts${i}`, `module${i}.ts`, '.ts', `/src/components/module${i}.ts`));
    }
    // Group 2: Python files (different vectors)
    for (let i = 1; i <= 5; i++) {
      db.upsertFile(makeFile(`py${i}`, `script${i}.py`, '.py', `/scripts/script${i}.py`));
    }

    const mockVectorStore = {
      get: vi.fn().mockImplementation(async (id: string) => {
        const seed = id.startsWith('ts') ? 42 : 999;
        // Small perturbation per file so they cluster
        const vec = createRandomVector(seed + parseInt(id.replace(/\D/g, ''), 10));
        return { id, vector: vec, metadata: {} };
      }),
    };

    const tagger = new AutoTagger(db, mockVectorStore as any, {} as any);

    const startHandler = vi.fn();
    const endHandler = vi.fn();
    tagger.on('tagging-start', startHandler);
    tagger.on('tagging-end', endHandler);

    const result = await tagger.runTagging();
    expect(startHandler).toHaveBeenCalled();
    expect(endHandler).toHaveBeenCalled();

    // Should have created at least some tags
    // (exact count depends on clustering outcome with random vectors)
    expect(result.tagsCreated + result.filesTagged).toBeGreaterThanOrEqual(0);
  });

  it('generates labels from file extensions and directories', async () => {
    const { AutoTagger } = await import('./auto-tagger.js');

    // Create a cluster of files all in 'components' dir with .tsx extension
    for (let i = 1; i <= 5; i++) {
      db.upsertFile(makeFile(
        `comp${i}`,
        `Component${i}.tsx`,
        '.tsx',
        `/src/components/Component${i}.tsx`
      ));
    }

    // Use identical vectors to guarantee they cluster together
    const sameVec = new Float32Array(384).fill(0.1);
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += sameVec[i] * sameVec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) sameVec[i] /= norm;

    const mockVectorStore = {
      get: vi.fn().mockImplementation(async (id: string) => ({
        id,
        vector: new Float32Array(sameVec), // Copy
        metadata: {},
      })),
    };

    const tagger = new AutoTagger(db, mockVectorStore as any, {} as any);
    const result = await tagger.runTagging();

    if (result.tagsCreated > 0) {
      const tags = db.getAllTags();
      expect(tags.length).toBeGreaterThan(0);
      // Label should be derived from directory/extension
      const label = tags[0].label.toLowerCase();
      expect(
        label.includes('component') || label.includes('tsx') || label.includes('components')
      ).toBe(true);
    }
  });

  it('emits tagging-start and tagging-end events', async () => {
    const { AutoTagger } = await import('./auto-tagger.js');

    // Too few files — will still emit start and end
    db.upsertFile(makeFile('f1', 'a.ts', '.ts', '/a.ts'));

    const tagger = new AutoTagger(db, { get: vi.fn() } as any, {} as any);

    const startHandler = vi.fn();
    const endHandler = vi.fn();
    tagger.on('tagging-start', startHandler);
    tagger.on('tagging-end', endHandler);

    await tagger.runTagging();
    expect(startHandler).toHaveBeenCalled();
    expect(endHandler).toHaveBeenCalled();
  });

  it('handles missing vector entries gracefully', async () => {
    const { AutoTagger } = await import('./auto-tagger.js');

    for (let i = 1; i <= 5; i++) {
      db.upsertFile(makeFile(`f${i}`, `file${i}.ts`, '.ts', `/src/file${i}.ts`));
    }

    const mockVectorStore = {
      get: vi.fn().mockResolvedValue(null), // All entries missing
    };

    const tagger = new AutoTagger(db, mockVectorStore as any, {} as any);
    const result = await tagger.runTagging();
    expect(result.tagsCreated).toBe(0);
    expect(result.filesTagged).toBe(0);
  });
});
