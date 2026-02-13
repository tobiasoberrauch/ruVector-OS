import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import type { IndexedFile } from '../shared/types.js';

// Mock @ruvector/graph-node to force fallback mode
vi.mock('@ruvector/graph-node', () => ({
  GraphDatabase: vi.fn().mockImplementation(() => {
    throw new Error('Native bindings not available');
  }),
}));

const testDir = join(tmpdir(), 'ruvector-dupetest');

function makeFile(overrides: Partial<IndexedFile>): IndexedFile {
  return {
    id: 'default',
    path: '/default',
    name: 'default.ts',
    extension: '.ts',
    size: 100,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    embeddedAt: Date.now(),
    contentPreview: 'content',
    contentHash: 'unique-hash',
    ...overrides,
  };
}

describe('MetadataDb — getContentHashDuplicates', () => {
  let db: MetadataDb;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    db = new MetadataDb(join(testDir, `dupe-${Date.now()}.db`));
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no duplicates', () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/a.ts', contentHash: 'hash-a' }));
    db.upsertFile(makeFile({ id: 'f2', path: '/b.ts', contentHash: 'hash-b' }));
    expect(db.getContentHashDuplicates()).toHaveLength(0);
  });

  it('finds exact content hash duplicates', () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/a.ts', contentHash: 'same-hash' }));
    db.upsertFile(makeFile({ id: 'f2', path: '/b.ts', contentHash: 'same-hash' }));
    db.upsertFile(makeFile({ id: 'f3', path: '/c.ts', contentHash: 'different' }));

    const dupes = db.getContentHashDuplicates();
    expect(dupes).toHaveLength(1);
    expect(dupes[0].contentHash).toBe('same-hash');
    expect(dupes[0].files).toHaveLength(2);
  });

  it('finds multiple duplicate groups', () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/a.ts', contentHash: 'hash-a' }));
    db.upsertFile(makeFile({ id: 'f2', path: '/b.ts', contentHash: 'hash-a' }));
    db.upsertFile(makeFile({ id: 'f3', path: '/c.ts', contentHash: 'hash-b' }));
    db.upsertFile(makeFile({ id: 'f4', path: '/d.ts', contentHash: 'hash-b' }));
    db.upsertFile(makeFile({ id: 'f5', path: '/e.ts', contentHash: 'hash-b' }));

    const dupes = db.getContentHashDuplicates();
    expect(dupes).toHaveLength(2);
    const groupB = dupes.find(g => g.contentHash === 'hash-b');
    expect(groupB!.files).toHaveLength(3);
  });
});

describe('KnowledgeGraph — duplicate edges', () => {
  it('connects duplicate files and finds groups', async () => {
    const { KnowledgeGraph } = await import('./knowledge-graph.js');
    const graph = new KnowledgeGraph();
    await graph.init();

    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.addFileNode('f3', 'file3.ts');

    // f1 and f2 are duplicates
    await graph.connectDuplicateFiles('f1', 'f2', 0.98);
    // f2 and f3 are duplicates (transitive)
    await graph.connectDuplicateFiles('f2', 'f3', 0.96);

    const groups = graph.getDuplicateGroups();
    expect(groups).toHaveLength(1); // All three connected
    expect(groups[0]).toHaveLength(3);
  });

  it('returns separate groups for unconnected duplicates', async () => {
    const { KnowledgeGraph } = await import('./knowledge-graph.js');
    const graph = new KnowledgeGraph();
    await graph.init();

    await graph.addFileNode('f1', 'a.ts');
    await graph.addFileNode('f2', 'b.ts');
    await graph.addFileNode('f3', 'c.ts');
    await graph.addFileNode('f4', 'd.ts');

    await graph.connectDuplicateFiles('f1', 'f2', 0.98);
    await graph.connectDuplicateFiles('f3', 'f4', 0.97);

    const groups = graph.getDuplicateGroups();
    expect(groups).toHaveLength(2);
  });

  it('does not include single files in groups', async () => {
    const { KnowledgeGraph } = await import('./knowledge-graph.js');
    const graph = new KnowledgeGraph();
    await graph.init();

    await graph.addFileNode('f1', 'a.ts');
    await graph.addFileNode('f2', 'b.ts');

    // Only one edge = group of 2
    await graph.connectDuplicateFiles('f1', 'f2', 0.98);

    const groups = graph.getDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('returns empty when no duplicate edges exist', async () => {
    const { KnowledgeGraph } = await import('./knowledge-graph.js');
    const graph = new KnowledgeGraph();
    await graph.init();

    await graph.addFileNode('f1', 'a.ts');
    await graph.addFileNode('f2', 'b.ts');
    await graph.connectSimilarFiles('f1', 'f2', 0.8); // similar, not duplicate

    const groups = graph.getDuplicateGroups();
    expect(groups).toHaveLength(0);
  });
});

describe('SimilaritySweep — duplicate threshold', () => {
  it('creates duplicate_of edge for scores >= 0.95', async () => {
    const { SimilaritySweep } = await import('./similarity-sweep.js');

    const vec = new Float32Array(384).fill(0.5);
    const metadataDb = { getAllFileIds: vi.fn().mockReturnValue(['f1']) };
    const vectorStore = {
      get: vi.fn().mockResolvedValue({ id: 'f1', vector: vec, metadata: {} }),
      search: vi.fn().mockResolvedValue([
        { id: 'f1', score: 1.0 },    // Self — skipped
        { id: 'f2', score: 0.97 },   // Above duplicate threshold
        { id: 'f3', score: 0.80 },   // Below duplicate threshold, above similarity
      ]),
    };
    const graph = {
      connectDuplicateFiles: vi.fn().mockResolvedValue(undefined),
      connectSimilarFiles: vi.fn().mockResolvedValue(undefined),
    };

    const sweep = new SimilaritySweep(
      metadataDb as any,
      vectorStore as any,
      graph as any,
    );

    await sweep.runSweep();

    expect(graph.connectDuplicateFiles).toHaveBeenCalledWith('f1', 'f2', 0.97);
    expect(graph.connectSimilarFiles).toHaveBeenCalledWith('f1', 'f3', 0.80);
  });
});
