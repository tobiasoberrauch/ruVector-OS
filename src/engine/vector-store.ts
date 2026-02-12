import { VECTOR_DIR } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';
import { join } from 'path';

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

  async init(): Promise<void> {
    await ensureDir(VECTOR_DIR);

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

  /** Insert or update a vector */
  async upsert(id: string, vector: Float32Array, metadata: Record<string, unknown>): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized');

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
    if (!this.db) throw new Error('VectorStore not initialized');

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
    if (!this.db) throw new Error('VectorStore not initialized');
    try {
      const entry = await this.db.get(id);
      return entry ?? null;
    } catch {
      return null;
    }
  }

  /** Delete an entry */
  async delete(id: string): Promise<boolean> {
    if (!this.db) throw new Error('VectorStore not initialized');
    try {
      return await this.db.delete(id);
    } catch {
      return false;
    }
  }

  /** Get total number of vectors */
  async count(): Promise<number> {
    if (!this.db) throw new Error('VectorStore not initialized');
    return await this.db.len();
  }
}
