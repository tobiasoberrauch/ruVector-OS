import { watch, type FSWatcher as ChokidarWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { stat } from 'fs/promises';
import { extname, basename, relative } from 'path';
import type { WatcherEvent, RuvectorConfig } from '../shared/types.js';
import { shouldIndex } from '../shared/utils.js';

export interface FSWatcherOptions {
  extensions: string[];
  ignoreDirs: string[];
  maxFileSize: number;
}

/**
 * File system watcher using chokidar (which uses native FSEvents on macOS).
 * Emits 'file-event' for new, changed, and deleted files.
 */
export class FSWatcher extends EventEmitter {
  private watchers: Map<string, ChokidarWatcher> = new Map();
  private options: FSWatcherOptions;
  private stats = {
    filesDetected: 0,
    filesIgnored: 0,
    errors: 0,
  };

  constructor(options: FSWatcherOptions) {
    super();
    this.options = options;
  }

  /** Start watching a directory */
  async watchDir(dir: string): Promise<void> {
    if (this.watchers.has(dir)) {
      return; // Already watching
    }

    const ignored = this.options.ignoreDirs.map(d => `**/${d}/**`);

    const watcher = watch(dir, {
      ignored,
      persistent: true,
      ignoreInitial: false, // Process existing files on first watch
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      // Use native FSEvents on macOS for near-zero CPU cost
      usePolling: false,
    });

    watcher.on('add', (path) => this.handleEvent('add', path));
    watcher.on('change', (path) => this.handleEvent('change', path));
    watcher.on('unlink', (path) => this.handleEvent('unlink', path));
    watcher.on('error', (error) => {
      this.stats.errors++;
      this.emit('error', error);
    });
    watcher.on('ready', () => {
      this.emit('ready', dir);
    });

    this.watchers.set(dir, watcher);
  }

  /** Stop watching a directory */
  async unwatchDir(dir: string): Promise<void> {
    const watcher = this.watchers.get(dir);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(dir);
    }
  }

  /** Stop all watchers */
  async close(): Promise<void> {
    const closers = [...this.watchers.values()].map(w => w.close());
    await Promise.all(closers);
    this.watchers.clear();
  }

  /** Get list of watched directories */
  getWatchedDirs(): string[] {
    return [...this.watchers.keys()];
  }

  /** Get watcher stats */
  getStats() {
    return { ...this.stats };
  }

  private async handleEvent(type: WatcherEvent['type'], path: string): Promise<void> {
    // Filter by extension
    if (!shouldIndex(path, this.options.extensions)) {
      this.stats.filesIgnored++;
      return;
    }

    // For add/change, check file size
    if (type !== 'unlink') {
      try {
        const fileStats = await stat(path);
        if (fileStats.size > this.options.maxFileSize) {
          this.stats.filesIgnored++;
          return;
        }
        if (!fileStats.isFile()) {
          return;
        }

        this.stats.filesDetected++;
        const event: WatcherEvent = {
          type,
          path,
          stats: {
            size: fileStats.size,
            mtime: fileStats.mtime,
          },
        };
        this.emit('file-event', event);
      } catch {
        this.stats.errors++;
      }
    } else {
      this.stats.filesDetected++;
      this.emit('file-event', { type, path } as WatcherEvent);
    }
  }
}
