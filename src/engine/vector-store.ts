import { VECTOR_DIR } from '../shared/paths.js';
import { ensureDir, isProcessRunning, readPidFile } from '../shared/utils.js';
import { join } from 'path';
import { existsSync, unlinkSync, readdirSync } from 'fs';

/**
 * Vector store backed by ruvector's HNSW index.
 * Stores 384-dim embeddings with metadata for sub-millisecond semantic search.
 */
export class VectorStore {
  private db: any = null;
  private storagePath: string;
  private dimensions: number;

  constructor(dimensions = 384) {
    this.storagePath = join(VECTOR_DIR, 'index.db');
    this.dimensions = dimensions;
  }

  /** Whether the store is open and ready for operations */
  isOpen(): boolean {
    return this.db !== null;
  }

  /** Close the vector store, releasing the file lock */
  close(): void {
    this.db = null;
  }

  /** Throw if the store has been closed or not yet initialized */
  private assertOpen(): void {
    if (!this.db) throw new Error('VectorStore not initialized or has been closed');
  }

  async init(): Promise<void> {
    await ensureDir(VECTOR_DIR);

    try {
      await this.openDb();
    } catch (err: any) {
      // If open fails, attempt stale lock cleanup and retry once
      if (err.message?.includes('lock') || err.message?.includes('already open') || err.message?.includes('SQLITE_BUSY')) {
        const cleaned = this.cleanStaleLocks();
        if (cleaned) {
          await this.openDb(); // Retry once — let it throw if it fails again
          return;
        }
      }
      throw err;
    }
  }

  /** Open the underlying VectorDb */
  private async openDb(): Promise<void> {
    const { VectorDb } = await import('ruvector');
    this.db = new VectorDb({
      dimensions: this.dimensions,
      storagePath: this.storagePath,
      distanceMetric: 'Cosine',
      hnswConfig: {
        m: 16,
        efConstruction: 200,
        efSearch: 100,
      },
    });
  }

  /**
   * Detect and remove stale lock files left by a crashed process.
   * Returns true if stale locks were cleaned.
   */
  cleanStaleLocks(): boolean {
    const pid = readPidFile();
    if (pid !== null && isProcessRunning(pid)) {
      // Another instance is legitimately running — don't clean
      return false;
    }

    let cleaned = false;
    const lockPatterns = ['.lock', '-shm', '-wal', '-journal'];

    try {
      const files = readdirSync(VECTOR_DIR);
      for (const file of files) {
        if (lockPatterns.some(p => file.endsWith(p))) {
          try {
            unlinkSync(join(VECTOR_DIR, file));
            cleaned = true;
          } catch {
            // Ignore individual file deletion errors
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return cleaned;
  }

  /** Insert or update a vector */
  async upsert(id: string, vector: Float32Array, metadata: Record<string, unknown>): Promise<void> {
    this.assertOpen();

    // Delete existing entry if present (upsert semantics)
    try {
      await this.db.delete(id);
    } catch {
      // Entry doesn't exist, that's fine
    }

    await this.db.insert({
      id,
      vector,
      metadata,
    });
  }

  /** Search for similar vectors */
  async search(
    vector: Float32Array,
    k = 10,
    threshold = 0.3
  ): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> {
    this.assertOpen();

    const results = await this.db.search({
      vector,
      k,
    });

    // Filter by threshold client-side
    return results
      .filter((r: any) => (r.score ?? 0) >= threshold)
      .map((r: any) => ({
        id: r.id,
        score: r.score ?? 0,
        metadata: r.metadata ?? {},
      }));
  }

  /** Get a specific entry by ID */
  async get(id: string): Promise<{ id: string; vector: Float32Array; metadata: Record<string, unknown> } | null> {
    this.assertOpen();
    try {
      const entry = await this.db.get(id);
      return entry ?? null;
    } catch {
      return null;
    }
  }

  /** Delete an entry */
  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    try {
      return await this.db.delete(id);
    } catch {
      return false;
    }
  }

  /** Get total number of vectors */
  async count(): Promise<number> {
    this.assertOpen();
    return await this.db.len();
  }

  /**
   * Insert or update multiple chunk vectors for a single file.
   * Chunk IDs follow the pattern `fileId:chunkIndex`.
   */
  async upsertChunks(
    fileId: string,
    chunks: Array<{ index: number; vector: Float32Array; metadata: Record<string, unknown> }>
  ): Promise<void> {
    this.assertOpen();
    for (const chunk of chunks) {
      const chunkId = `${fileId}:${chunk.index}`;
      await this.upsert(chunkId, chunk.vector, {
        ...chunk.metadata,
        fileId,
        chunkIndex: chunk.index,
      });
    }
  }

  /**
   * Delete all vectors for a file by prefix.
   * Removes all entries with IDs starting with `fileId:`.
   * Also removes the non-chunked entry with just `fileId` (backward compat).
   */
  async deleteByPrefix(fileId: string): Promise<number> {
    this.assertOpen();
    let deleted = 0;

    // Delete the legacy non-chunked entry
    if (await this.delete(fileId)) {
      deleted++;
    }

    // Delete chunk entries: fileId:0, fileId:1, ..., fileId:N
    // We don't know how many chunks exist, so try up to a reasonable limit
    for (let i = 0; i < 1000; i++) {
      const chunkId = `${fileId}:${i}`;
      const success = await this.delete(chunkId);
      if (success) {
        deleted++;
      } else {
        // No more chunks — stop once we hit a gap
        // But continue a few more in case of sparse indices
        let gapDone = true;
        for (let j = i + 1; j < i + 3 && j < 1000; j++) {
          if (await this.delete(`${fileId}:${j}`)) {
            deleted++;
            gapDone = false;
          }
        }
        if (gapDone) break;
        i += 3;
      }
    }

    return deleted;
  }
}
