import { EventEmitter } from 'events';
import type { MetadataDb } from './metadata-db.js';
import type { VectorStore } from './vector-store.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import { shouldDeferHeavyWork } from '../shared/battery.js';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SAMPLE_SIZE = 100;
const TOP_K = 5;
const SIMILARITY_THRESHOLD = 0.7;
const DUPLICATE_THRESHOLD = 0.95;
const RATE_LIMIT_PER_SEC = 20;

/**
 * Background similarity discovery sweep.
 * Periodically samples files, finds similar pairs via HNSW,
 * and creates `similar_to` edges in the knowledge graph.
 */
export class SimilaritySweep extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSweepTime = 0;
  private sweepFileCount = 0;

  constructor(
    private metadataDb: MetadataDb,
    private vectorStore: VectorStore,
    private graph: KnowledgeGraph,
    private intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    super();
  }

  /** Start the periodic sweep timer */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runSweep().catch(err => this.emit('error', err));
    }, this.intervalMs);
  }

  /** Stop the periodic sweep timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether a sweep is currently in progress */
  isRunning(): boolean {
    return this.running;
  }

  /** Last sweep timestamp */
  getLastSweepTime(): number {
    return this.lastSweepTime;
  }

  /** Number of files processed in last sweep */
  getSweepFileCount(): number {
    return this.sweepFileCount;
  }

  /**
   * Run a single similarity discovery sweep.
   * Samples files, finds similar pairs, creates graph edges.
   */
  async runSweep(): Promise<{ filesProcessed: number; edgesCreated: number }> {
    if (this.running) return { filesProcessed: 0, edgesCreated: 0 };

    // Battery-aware: defer sweep if on battery with low charge
    if (await shouldDeferHeavyWork()) {
      this.emit('sweep-deferred');
      return { filesProcessed: 0, edgesCreated: 0 };
    }

    this.running = true;
    this.emit('sweep-start');

    let filesProcessed = 0;
    let edgesCreated = 0;

    try {
      const allIds = this.metadataDb.getAllFileIds();
      if (allIds.length === 0) {
        this.running = false;
        this.emit('sweep-end', { filesProcessed: 0, edgesCreated: 0 });
        return { filesProcessed: 0, edgesCreated: 0 };
      }

      // Random sample of N files (or all if fewer)
      const sampleIds = this.sampleArray(allIds, SAMPLE_SIZE);

      for (const fileId of sampleIds) {
        // Rate limiting: process max RATE_LIMIT_PER_SEC per second
        if (filesProcessed > 0 && filesProcessed % RATE_LIMIT_PER_SEC === 0) {
          await this.sleep(1000);
        }

        try {
          const entry = await this.vectorStore.get(fileId);
          if (!entry) continue;

          // Search for similar files using the file's own embedding
          const similar = await this.vectorStore.search(
            entry.vector,
            TOP_K + 1, // +1 because the file itself will be in results
            SIMILARITY_THRESHOLD,
          );

          for (const match of similar) {
            // Skip self-matches
            if (match.id === fileId) continue;

            // Create edge based on similarity level
            try {
              if (match.score >= DUPLICATE_THRESHOLD) {
                await this.graph.connectDuplicateFiles(fileId, match.id, match.score);
              } else {
                await this.graph.connectSimilarFiles(fileId, match.id, match.score);
              }
              edgesCreated++;
            } catch {
              // Edge already exists or node missing; skip
            }
          }

          filesProcessed++;
          this.emit('sweep-progress', {
            processed: filesProcessed,
            total: sampleIds.length,
            edges: edgesCreated,
          });
        } catch {
          // Skip individual file errors
        }
      }

      this.lastSweepTime = Date.now();
      this.sweepFileCount = filesProcessed;
    } finally {
      this.running = false;
      this.emit('sweep-end', { filesProcessed, edgesCreated });
    }

    return { filesProcessed, edgesCreated };
  }

  /** Randomly sample n items from an array */
  private sampleArray<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return [...arr];
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, n);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
