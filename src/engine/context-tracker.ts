import { dirname } from 'path';
import type { MetadataDb } from './metadata-db.js';

/** Time window for "recent" context: 30 minutes */
const CONTEXT_WINDOW_MS = 30 * 60 * 1000;

/** Max age for context events before pruning: 7 days */
const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Context tracker for Tier 3.
 *
 * Tracks which files the user is actively working with (via clicks, searches, accesses)
 * and provides a contextual boost for search results that are related to the active context.
 *
 * Context signals:
 * - Files clicked in recent searches
 * - Files in the same directory as recently accessed files
 * - Files with the same tags as recently accessed files
 */
export class ContextTracker {
  constructor(private metadataDb: MetadataDb) {}

  /** Record that a file was accessed/clicked */
  recordAccess(fileId: string): void {
    this.metadataDb.recordContextEvent(fileId, 'access');
  }

  /** Record that a file appeared in search results */
  recordSearchResult(fileId: string): void {
    this.metadataDb.recordContextEvent(fileId, 'shown');
  }

  /**
   * Get the current active context: a set of file IDs and their directories
   * that the user has been recently working with.
   */
  getActiveContext(): {
    recentFileIds: Set<string>;
    activeDirectories: Set<string>;
    contextStrength: Map<string, number>;
  } {
    const events = this.metadataDb.getRecentContext(CONTEXT_WINDOW_MS);

    const recentFileIds = new Set<string>();
    const activeDirectories = new Set<string>();
    const contextStrength = new Map<string, number>();

    const now = Date.now();
    for (const event of events) {
      recentFileIds.add(event.fileId);

      // Resolve the file to get its directory
      const file = this.metadataDb.getFile(event.fileId);
      if (file) {
        activeDirectories.add(dirname(file.path));
      }

      // Compute strength based on recency and event type
      const age = now - event.timestamp;
      const recency = 1 - (age / CONTEXT_WINDOW_MS); // 1.0 = just now, 0.0 = edge of window
      const typeWeight = event.eventType === 'access' ? 1.0 : 0.3;
      const strength = recency * typeWeight;

      const existing = contextStrength.get(event.fileId) ?? 0;
      contextStrength.set(event.fileId, Math.max(existing, strength));
    }

    return { recentFileIds, activeDirectories, contextStrength };
  }

  /**
   * Compute a context boost score for a file.
   * Returns 0-1 based on how relevant the file is to the current context.
   */
  getContextBoost(fileId: string, filePath: string): number {
    const ctx = this.getActiveContext();

    let boost = 0;

    // Direct match: file was recently accessed
    const directStrength = ctx.contextStrength.get(fileId);
    if (directStrength) {
      boost = Math.max(boost, directStrength * 0.5);
    }

    // Directory match: file is in an active directory
    const fileDir = dirname(filePath);
    if (ctx.activeDirectories.has(fileDir)) {
      boost = Math.max(boost, 0.15);
    }

    // Same parent directory (one level up)
    const parentDir = dirname(fileDir);
    for (const activeDir of ctx.activeDirectories) {
      if (dirname(activeDir) === parentDir && activeDir !== fileDir) {
        boost = Math.max(boost, 0.05);
        break;
      }
    }

    return Math.min(1, boost);
  }

  /** Prune old context events */
  prune(): number {
    return this.metadataDb.pruneContextEvents(CONTEXT_MAX_AGE_MS);
  }
}
