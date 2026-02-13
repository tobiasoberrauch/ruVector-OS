import { describe, it, expect, afterEach, vi } from 'vitest';
import { FSWatcher } from './fs-watcher.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile, rm, unlink } from 'fs/promises';
import type { WatcherEvent } from '../shared/types.js';

const testRoot = join(tmpdir(), 'ruvector-watcher-test');

function createWatcher(overrides: Partial<ConstructorParameters<typeof FSWatcher>[0]> = {}) {
  return new FSWatcher({
    extensions: ['.ts', '.js', '.md'],
    ignoreDirs: ['node_modules', '.git'],
    maxFileSize: 1024 * 1024,
    ...overrides,
  });
}

/** Wait for an event on the watcher, with timeout */
function waitForEvent(watcher: FSWatcher, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    watcher.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Collect file-events into an array for a given duration */
function collectEvents(watcher: FSWatcher, durationMs = 2000): Promise<WatcherEvent[]> {
  const events: WatcherEvent[] = [];
  const listener = (e: WatcherEvent) => events.push(e);
  watcher.on('file-event', listener);
  return new Promise(resolve => {
    setTimeout(() => {
      watcher.off('file-event', listener);
      resolve(events);
    }, durationMs);
  });
}

describe('FSWatcher', () => {
  let testDir: string;
  let watcher: FSWatcher;

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
    }
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('emits ready when watching a directory', async () => {
    testDir = join(testRoot, `ready-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher();

    const readyPromise = waitForEvent(watcher, 'ready');
    await watcher.watchDir(testDir);
    const dir = await readyPromise;
    expect(dir).toBe(testDir);
  });

  it('detects new file additions', async () => {
    testDir = join(testRoot, `add-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher();

    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    const eventsPromise = collectEvents(watcher, 3000);
    // Small delay to ensure watcher is fully settled
    await new Promise(r => setTimeout(r, 500));
    await writeFile(join(testDir, 'new-file.ts'), 'const x = 1;');
    const events = await eventsPromise;

    const addEvents = events.filter(e => e.type === 'add' && e.path.includes('new-file.ts'));
    expect(addEvents.length).toBeGreaterThanOrEqual(1);
    expect(addEvents[0].stats?.size).toBeGreaterThan(0);
  });

  it('detects file changes', async () => {
    testDir = join(testRoot, `change-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'existing.ts');
    await writeFile(filePath, 'const x = 1;');

    watcher = createWatcher();
    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    const eventsPromise = collectEvents(watcher, 3000);
    await new Promise(r => setTimeout(r, 500));
    await writeFile(filePath, 'const x = 2; // modified');
    const events = await eventsPromise;

    const changeEvents = events.filter(e => e.type === 'change' && e.path.includes('existing.ts'));
    expect(changeEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('detects file deletions', async () => {
    testDir = join(testRoot, `unlink-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'delete-me.ts');
    await writeFile(filePath, 'to be deleted');

    watcher = createWatcher();
    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    const eventsPromise = collectEvents(watcher, 3000);
    await new Promise(r => setTimeout(r, 500));
    await unlink(filePath);
    const events = await eventsPromise;

    const unlinkEvents = events.filter(e => e.type === 'unlink' && e.path.includes('delete-me.ts'));
    expect(unlinkEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by extension', async () => {
    testDir = join(testRoot, `ext-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher({ extensions: ['.ts'] });

    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    const eventsPromise = collectEvents(watcher, 3000);
    await new Promise(r => setTimeout(r, 500));
    await writeFile(join(testDir, 'allowed.ts'), 'const x = 1;');
    await writeFile(join(testDir, 'blocked.py'), 'x = 1');
    const events = await eventsPromise;

    const tsEvents = events.filter(e => e.path.includes('allowed.ts'));
    const pyEvents = events.filter(e => e.path.includes('blocked.py'));
    expect(tsEvents.length).toBeGreaterThanOrEqual(1);
    expect(pyEvents.length).toBe(0);
  });

  it('filters by maxFileSize', async () => {
    testDir = join(testRoot, `size-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher({ maxFileSize: 50 }); // Very small limit

    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    const eventsPromise = collectEvents(watcher, 3000);
    await new Promise(r => setTimeout(r, 500));
    await writeFile(join(testDir, 'small.ts'), 'x');
    await writeFile(join(testDir, 'large.ts'), 'x'.repeat(200));
    const events = await eventsPromise;

    const smallEvents = events.filter(e => e.path.includes('small.ts'));
    const largeEvents = events.filter(e => e.path.includes('large.ts'));
    expect(smallEvents.length).toBeGreaterThanOrEqual(1);
    expect(largeEvents.length).toBe(0);
  });

  it('tracks watched directories', async () => {
    testDir = join(testRoot, `dirs-${Date.now()}`);
    const dir2 = join(testRoot, `dirs2-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await mkdir(dir2, { recursive: true });
    watcher = createWatcher();

    await watcher.watchDir(testDir);
    await watcher.watchDir(dir2);
    expect(watcher.getWatchedDirs()).toContain(testDir);
    expect(watcher.getWatchedDirs()).toContain(dir2);

    await watcher.unwatchDir(testDir);
    expect(watcher.getWatchedDirs()).not.toContain(testDir);
    expect(watcher.getWatchedDirs()).toContain(dir2);
  });

  it('does not duplicate-watch the same directory', async () => {
    testDir = join(testRoot, `dup-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher();

    await watcher.watchDir(testDir);
    await watcher.watchDir(testDir); // Should be a no-op
    expect(watcher.getWatchedDirs()).toHaveLength(1);
  });

  it('close stops all watchers', async () => {
    testDir = join(testRoot, `close-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher();

    await watcher.watchDir(testDir);
    await watcher.close();
    expect(watcher.getWatchedDirs()).toHaveLength(0);
  });

  it('tracks stats', async () => {
    testDir = join(testRoot, `stats-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    watcher = createWatcher();

    await watcher.watchDir(testDir);
    await waitForEvent(watcher, 'ready');

    await new Promise(r => setTimeout(r, 500));
    await writeFile(join(testDir, 'tracked.ts'), 'const y = 1;');
    await new Promise(r => setTimeout(r, 2000));

    const stats = watcher.getStats();
    expect(stats.filesDetected).toBeGreaterThanOrEqual(1);
  });
});
