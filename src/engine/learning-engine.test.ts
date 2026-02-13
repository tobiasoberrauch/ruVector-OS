import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataDb } from './metadata-db.js';
import { LearningEngine } from './learning-engine.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import type { IndexedFile } from '../shared/types.js';

// Mock KnowledgeGraph
const mockGraph = {
  connectSimilarFiles: vi.fn().mockResolvedValue(undefined),
};

const testDir = join(tmpdir(), 'ruvector-learning-test');
let db: MetadataDb;
let engine: LearningEngine;

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
  const dbPath = join(testDir, `test-learning-${Date.now()}.db`);
  db = new MetadataDb(dbPath);
  await db.init();
  engine = new LearningEngine(db, mockGraph as any);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('LearningEngine — EMA importance', () => {
  it('first click sets importance via EMA formula', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    const searchId = db.logSearchWithId('test query', ['f1']);

    await engine.recordClick(searchId, 'f1', 0);

    // EMA: α * 1.0 + (1 - α) * 0 = 0.1
    const importance = db.getImportance('f1');
    expect(importance).toBeCloseTo(0.1, 2);
  });

  it('repeated clicks increase importance', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));

    const s1 = db.logSearchWithId('q1', ['f1']);
    await engine.recordClick(s1, 'f1', 0);
    const score1 = db.getImportance('f1');

    const s2 = db.logSearchWithId('q2', ['f1']);
    await engine.recordClick(s2, 'f1', 0);
    const score2 = db.getImportance('f1');

    expect(score2).toBeGreaterThan(score1);
  });

  it('EMA converges: α * 1 + (1-α) * prev', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));

    // Click 5 times
    for (let i = 0; i < 5; i++) {
      const sid = db.logSearchWithId(`q${i}`, ['f1']);
      await engine.recordClick(sid, 'f1', 0);
    }

    const score = db.getImportance('f1');
    // After 5 clicks with α=0.1: score = 0.1 + 0.9*(0.1 + 0.9*(0.1 + ...))
    // Should be around 0.40951
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(1.0);
  });
});

describe('LearningEngine — decay', () => {
  it('decays all importance scores by decayFactor', () => {
    db.setImportance('f1', 0.5, 3, 10);
    db.setImportance('f2', 0.8, 5, 15);

    engine.decayAll();

    expect(db.getImportance('f1')).toBeCloseTo(0.5 * 0.95, 4);
    expect(db.getImportance('f2')).toBeCloseTo(0.8 * 0.95, 4);
  });

  it('prunes entries below pruneThreshold after decay', () => {
    db.setImportance('f1', 0.005, 0, 1); // Below threshold after decay
    db.setImportance('f2', 0.5, 3, 10);

    const pruned = engine.decayAll();
    expect(pruned).toBe(1);
    expect(db.getImportance('f1')).toBe(0);
    expect(db.getImportance('f2')).toBeGreaterThan(0);
  });

  it('returns 0 pruned when all scores are above threshold', () => {
    db.setImportance('f1', 0.5, 3, 10);
    db.setImportance('f2', 0.8, 5, 15);

    const pruned = engine.decayAll();
    expect(pruned).toBe(0);
  });
});

describe('LearningEngine — sessions', () => {
  it('creates a session on first click', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    const searchId = db.logSearchWithId('q', ['f1']);

    await engine.recordClick(searchId, 'f1', 0);

    // Session should be created (no throw)
    const sessionId = engine.ensureSession();
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  it('reuses the same session across clicks', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    const s1 = db.logSearchWithId('q1', ['f1']);
    await engine.recordClick(s1, 'f1', 0);
    const session1 = engine.ensureSession();

    const s2 = db.logSearchWithId('q2', ['f1']);
    await engine.recordClick(s2, 'f1', 0);
    const session2 = engine.ensureSession();

    expect(session1).toBe(session2);
  });
});

describe('LearningEngine — co-access edges', () => {
  it('creates co-access edges within a session', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    db.upsertFile(makeFile({ id: 'f2', path: '/f2' }));

    // Ensure session is created first so timestamps align
    engine.ensureSession();
    await new Promise(r => setTimeout(r, 10));

    const s1 = db.logSearchWithId('q', ['f1', 'f2']);
    await engine.recordClick(s1, 'f1', 0);
    await new Promise(r => setTimeout(r, 10));
    await engine.recordClick(s1, 'f2', 1);

    // After clicking f2, it should try to connect f2 with f1 (co-accessed)
    expect(mockGraph.connectSimilarFiles).toHaveBeenCalled();
  });
});

describe('LearningEngine — metrics', () => {
  it('returns correct metrics', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    const searchId = db.logSearchWithId('q', ['f1']);
    await engine.recordClick(searchId, 'f1', 0);

    const metrics = engine.getMetrics(12345, 100, true);
    expect(metrics.totalSearches).toBe(1);
    expect(metrics.totalClicks).toBe(1);
    expect(metrics.clickThroughRate).toBe(1);
    expect(metrics.lastSweepTime).toBe(12345);
    expect(metrics.sweepFileCount).toBe(100);
    expect(metrics.gnnActive).toBe(true);
    expect(metrics.topFilesByImportance).toHaveLength(1);
    expect(metrics.topFilesByImportance[0].fileId).toBe('f1');
  });

  it('returns zero metrics when empty', () => {
    const metrics = engine.getMetrics();
    expect(metrics.totalSearches).toBe(0);
    expect(metrics.totalClicks).toBe(0);
    expect(metrics.clickThroughRate).toBe(0);
  });
});

describe('LearningEngine — reset', () => {
  it('clears all learning data', async () => {
    db.upsertFile(makeFile({ id: 'f1', path: '/f1' }));
    const searchId = db.logSearchWithId('q', ['f1']);
    await engine.recordClick(searchId, 'f1', 0);

    engine.reset();

    expect(db.getImportance('f1')).toBe(0);
    expect(db.getAllImportance()).toHaveLength(0);
  });
});
