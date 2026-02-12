import type { MetadataDb } from './metadata-db.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { LearningMetrics } from '../shared/types.js';
import { randomUUID } from 'crypto';

/**
 * Learning orchestrator for Tier 2.
 * Tracks click feedback, maintains per-file importance scores via EMA,
 * strengthens co-access edges, handles decay, and reports metrics.
 */
export class LearningEngine {
  private alpha = 0.1; // EMA smoothing factor
  private decayFactor = 0.95;
  private pruneThreshold = 0.01;
  private currentSessionId: string | null = null;

  constructor(
    private metadataDb: MetadataDb,
    private graph: KnowledgeGraph,
  ) {}

  /** Start or get the current session */
  ensureSession(): string {
    if (!this.currentSessionId) {
      this.currentSessionId = randomUUID();
      this.metadataDb.createSession(this.currentSessionId);
    }
    return this.currentSessionId;
  }

  /**
   * Record a click on a search result.
   * Updates the file's importance score via EMA and
   * strengthens co-access edges within the session.
   */
  async recordClick(searchId: number, fileId: string, position: number): Promise<void> {
    // Record the raw click
    this.metadataDb.recordClick(searchId, fileId, position);

    // Update importance via EMA
    const current = this.metadataDb.getImportance(fileId);
    const allRows = this.metadataDb.getAllImportance();
    const existing = allRows.find(r => r.fileId === fileId);
    const clickCount = (existing?.clickCount ?? 0) + 1;
    const shownCount = existing?.shownCount ?? 0;

    // EMA: importance = α * 1.0 + (1 - α) * current
    const newScore = this.alpha * 1.0 + (1 - this.alpha) * current;
    this.metadataDb.setImportance(fileId, newScore, clickCount, shownCount);

    // Touch session for co-access tracking
    const sessionId = this.ensureSession();
    this.metadataDb.touchSession(sessionId);

    // Strengthen co-access edges
    await this.strengthenCoAccessEdges(fileId);
  }

  /**
   * When file A is clicked in the same session as files B, C, etc.,
   * strengthen the co_accessed / similar_to edge between them.
   */
  private async strengthenCoAccessEdges(clickedFileId: string): Promise<void> {
    if (!this.currentSessionId) return;

    const sessionClicks = this.metadataDb.getSessionClicks(this.currentSessionId);
    const otherFiles = sessionClicks
      .map(c => c.fileId)
      .filter(id => id !== clickedFileId);

    // Deduplicate
    const unique = [...new Set(otherFiles)];
    for (const otherFileId of unique) {
      try {
        await this.graph.connectSimilarFiles(clickedFileId, otherFileId, 0.5);
      } catch {
        // Edge may already exist or nodes may be missing; skip
      }
    }
  }

  /**
   * Decay all importance scores.
   * Multiplies every score by decayFactor (0.95) and prunes entries below threshold.
   */
  decayAll(): number {
    const allRows = this.metadataDb.getAllImportance();
    for (const row of allRows) {
      const decayed = row.score * this.decayFactor;
      this.metadataDb.setImportance(row.fileId, decayed, row.clickCount, row.shownCount);
    }
    return this.metadataDb.pruneImportance(this.pruneThreshold);
  }

  /** Get learning metrics for dashboard / CLI / MCP */
  getMetrics(lastSweepTime = 0, sweepFileCount = 0, gnnActive = false): LearningMetrics {
    const stats = this.metadataDb.getSearchClickStats();
    const topFiles = this.metadataDb.getTopFiles(5);

    // Resolve file paths
    const topFilesByImportance = topFiles.map(f => {
      const file = this.metadataDb.getFile(f.fileId);
      return {
        fileId: f.fileId,
        path: file?.path ?? f.fileId,
        score: f.score,
      };
    });

    return {
      totalSearches: stats.totalSearches,
      totalClicks: stats.totalClicks,
      clickThroughRate: stats.ctr,
      topFilesByImportance,
      lastSweepTime,
      sweepFileCount,
      gnnActive,
    };
  }

  /** Clear all learning data (for reset command) */
  reset(): void {
    this.metadataDb.clearLearningData();
    this.currentSessionId = null;
  }
}
