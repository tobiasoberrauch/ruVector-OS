import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, unlink, rmdir } from 'fs/promises';
import type { IndexedFile } from '../shared/types.js';

const testDir = join(tmpdir(), 'ruvector-metadb-test');
let db: MetadataDb;

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    id: 'test-id-001',
    path: '/tmp/test/file.ts',
    name: 'file.ts',
    extension: '.ts',
    size: 1234,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    embeddedAt: Date.now(),
    contentPreview: 'const x = 1;',
    contentHash: 'abc123',
    ...overrides,
  };
}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true });
  const dbPath = join(testDir, `test-${Date.now()}.db`);
  db = new MetadataDb(dbPath);
  await db.init();
});

afterEach(() => {
  db.close();
});

describe('MetadataDb — file CRUD', () => {
  it('inserts and retrieves a file by ID', () => {
    const file = makeFile();
    db.upsertFile(file);
    const retrieved = db.getFile('test-id-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.path).toBe('/tmp/test/file.ts');
    expect(retrieved!.contentPreview).toBe('const x = 1;');
  });

  it('retrieves a file by path', () => {
    const file = makeFile();
    db.upsertFile(file);
    const retrieved = db.getFileByPath('/tmp/test/file.ts');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('test-id-001');
  });

  it('returns null for non-existent file', () => {
    expect(db.getFile('nonexistent')).toBeNull();
    expect(db.getFileByPath('/no/such/file')).toBeNull();
  });

  it('updates a file on re-upsert', () => {
    db.upsertFile(makeFile());
    db.upsertFile(makeFile({ contentPreview: 'updated' }));
    const retrieved = db.getFile('test-id-001');
    expect(retrieved!.contentPreview).toBe('updated');
  });

  it('deletes a file by ID', () => {
    db.upsertFile(makeFile());
    db.deleteFile('test-id-001');
    expect(db.getFile('test-id-001')).toBeNull();
  });

  it('deletes a file by path', () => {
    db.upsertFile(makeFile());
    db.deleteFileByPath('/tmp/test/file.ts');
    expect(db.getFileByPath('/tmp/test/file.ts')).toBeNull();
  });

  it('counts files correctly', () => {
    expect(db.fileCount()).toBe(0);
    db.upsertFile(makeFile({ id: 'a', path: '/a' }));
    db.upsertFile(makeFile({ id: 'b', path: '/b' }));
    expect(db.fileCount()).toBe(2);
  });

  it('gets files by extension', () => {
    db.upsertFile(makeFile({ id: 'a', path: '/a.ts', extension: '.ts' }));
    db.upsertFile(makeFile({ id: 'b', path: '/b.py', extension: '.py' }));
    db.upsertFile(makeFile({ id: 'c', path: '/c.ts', extension: '.ts' }));
    const tsFiles = db.getFilesByExtension('.ts');
    expect(tsFiles).toHaveLength(2);
  });

  it('gets all file IDs', () => {
    db.upsertFile(makeFile({ id: 'x', path: '/x' }));
    db.upsertFile(makeFile({ id: 'y', path: '/y' }));
    const ids = db.getAllFileIds();
    expect(ids).toContain('x');
    expect(ids).toContain('y');
  });
});

describe('MetadataDb — search history', () => {
  it('logs a search', () => {
    db.logSearch('test query', ['id1', 'id2']);
    const stats = db.getStats();
    expect(stats.searches).toBe(1);
  });

  it('logs a search with ID and returns it', () => {
    const id = db.logSearchWithId('query', ['r1']);
    expect(id).toBeGreaterThan(0);
  });

  it('tracks search click stats', () => {
    const searchId = db.logSearchWithId('q1', ['f1', 'f2']);
    db.recordClick(searchId, 'f1', 0);
    const stats = db.getSearchClickStats();
    expect(stats.totalSearches).toBe(1);
    expect(stats.totalClicks).toBe(1);
    expect(stats.ctr).toBe(1);
  });
});

describe('MetadataDb — importance scores', () => {
  it('returns 0 for unknown file', () => {
    expect(db.getImportance('unknown')).toBe(0);
  });

  it('sets and gets importance', () => {
    db.setImportance('f1', 0.75, 3, 10);
    expect(db.getImportance('f1')).toBe(0.75);
  });

  it('gets all importance entries', () => {
    db.setImportance('f1', 0.5, 1, 5);
    db.setImportance('f2', 0.8, 2, 8);
    const all = db.getAllImportance();
    expect(all).toHaveLength(2);
  });

  it('prunes low importance entries', () => {
    db.setImportance('low', 0.01, 0, 1);
    db.setImportance('high', 0.9, 5, 10);
    const pruned = db.pruneImportance(0.1);
    expect(pruned).toBe(1);
    expect(db.getImportance('low')).toBe(0);
    expect(db.getImportance('high')).toBe(0.9);
  });

  it('increments shown counts', () => {
    db.incrementShownCount(['f1', 'f2']);
    const all = db.getAllImportance();
    expect(all).toHaveLength(2);
    const f1 = all.find(r => r.fileId === 'f1');
    expect(f1!.shownCount).toBe(1);
  });
});

describe('MetadataDb — tags (Tier 3)', () => {
  it('creates a tag and returns its ID', () => {
    const id = db.upsertTag('TypeScript Files');
    expect(id).toBe('typescript-files');
  });

  it('tags a file and retrieves tags', () => {
    const tagId = db.upsertTag('Config');
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    db.tagFile('f1', tagId, 0.9);
    const tags = db.getFileTags('f1');
    expect(tags).toHaveLength(1);
    expect(tags[0].label).toBe('Config');
    expect(tags[0].confidence).toBe(0.9);
  });

  it('gets files by tag', () => {
    const tagId = db.upsertTag('Source');
    db.tagFile('a', tagId, 1.0);
    db.tagFile('b', tagId, 0.8);
    const files = db.getFilesByTag(tagId);
    expect(files).toHaveLength(2);
  });

  it('gets all tags with file counts', () => {
    const t1 = db.upsertTag('Alpha');
    const t2 = db.upsertTag('Beta');
    db.tagFile('f1', t1, 1.0);
    db.tagFile('f2', t1, 0.9);
    db.tagFile('f3', t2, 0.8);
    const all = db.getAllTags();
    expect(all).toHaveLength(2);
    const alpha = all.find(t => t.label === 'Alpha');
    expect(alpha!.fileCount).toBe(2);
  });

  it('clears file tags', () => {
    const tagId = db.upsertTag('Temp');
    db.tagFile('f1', tagId, 1.0);
    db.clearFileTags('f1');
    expect(db.getFileTags('f1')).toHaveLength(0);
  });
});

describe('MetadataDb — context events (Tier 3)', () => {
  it('records and retrieves context events', () => {
    db.recordContextEvent('f1', 'search_result');
    db.recordContextEvent('f2', 'click');
    const events = db.getRecentContext(60000);
    expect(events).toHaveLength(2);
  });

  it('prunes old context events', async () => {
    db.recordContextEvent('f1', 'old');
    // Small delay so the event timestamp is in the past relative to pruneContextEvents
    await new Promise(r => setTimeout(r, 10));
    // olderThanMs = 0 means cutoff = Date.now(), so events with timestamp < now get pruned
    const pruned = db.pruneContextEvents(0);
    expect(pruned).toBeGreaterThanOrEqual(1);
  });
});

describe('MetadataDb — analytics (Tier 3)', () => {
  it('gets top queries', () => {
    db.logSearch('query A', []);
    db.logSearch('query A', []);
    db.logSearch('query B', []);
    const top = db.getTopQueries(5);
    expect(top[0].query).toBe('query A');
    expect(top[0].count).toBe(2);
  });

  it('gets search volume by day', () => {
    db.logSearch('q', []);
    const volume = db.getSearchVolumeByDay(1);
    expect(volume.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MetadataDb — stats', () => {
  it('sets and gets a stat', () => {
    db.setStat('version', '0.1.0');
    expect(db.getStat('version')).toBe('0.1.0');
  });

  it('returns null for missing stat', () => {
    expect(db.getStat('nope')).toBeNull();
  });

  it('reports storage stats', () => {
    const stats = db.getStats();
    expect(stats.files).toBe(0);
    expect(stats.dbSize).toBeGreaterThan(0);
  });
});
