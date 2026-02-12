import { RuvectorLayer } from '@ruvector/gnn';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { MetadataDb } from './metadata-db.js';
import type { VectorStore } from './vector-store.js';
import type { SearchResult } from '../shared/types.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { ensureDir } from '../shared/utils.js';
import { DATA_DIR } from '../shared/paths.js';

const WEIGHTS_PATH = join(DATA_DIR, 'learning', 'gnn-weights.json');
const INPUT_DIM = 384;
const HIDDEN_DIM = 384;
const HEADS = 4;
const DROPOUT = 0.0; // No dropout at inference

/**
 * GNN-based re-ranking layer.
 * Uses @ruvector/gnn RuvectorLayer for inference-only re-ranking:
 * 1. For each candidate, fetch k-hop neighbors from the knowledge graph
 * 2. Look up importance scores for neighbors
 * 3. Run RuvectorLayer.forward() to get attention-weighted aggregated embedding
 * 4. Blend: finalScore = 0.7 * vectorScore + 0.2 * gnnScore + 0.1 * importanceScore
 */
export class GnnRanker {
  private layer: RuvectorLayer | null = null;
  private active = false;

  constructor(
    private graph: KnowledgeGraph,
    private metadataDb: MetadataDb,
    private vectorStore: VectorStore,
  ) {}

  /** Initialize the GNN layer, loading saved weights if available */
  async init(): Promise<void> {
    try {
      if (existsSync(WEIGHTS_PATH)) {
        const json = await readFile(WEIGHTS_PATH, 'utf-8');
        this.layer = RuvectorLayer.fromJson(json);
      } else {
        this.layer = new RuvectorLayer(INPUT_DIM, HIDDEN_DIM, HEADS, DROPOUT);
      }
      this.active = true;
    } catch {
      // GNN native bindings not available — graceful fallback
      this.layer = null;
      this.active = false;
    }
  }

  /** Save current layer weights to disk */
  async saveWeights(): Promise<void> {
    if (!this.layer) return;
    try {
      await ensureDir(dirname(WEIGHTS_PATH));
      const json = this.layer.toJson();
      await writeFile(WEIGHTS_PATH, json, 'utf-8');
    } catch {
      // Best effort
    }
  }

  /** Whether the GNN ranker is active */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Re-rank search results using GNN neighbor aggregation + importance scores.
   * Falls back to original scores if GNN is unavailable or errors occur.
   */
  async rerank(
    queryEmbedding: Float32Array,
    results: SearchResult[],
    limit: number,
  ): Promise<SearchResult[]> {
    if (!this.layer || !this.active || results.length === 0) {
      return results.slice(0, limit);
    }

    try {
      const reranked = await Promise.all(
        results.map(async (result) => {
          const gnnScore = await this.computeGnnScore(queryEmbedding, result.file.id);
          const importance = this.metadataDb.getImportance(result.file.id);

          // Blend: 0.7 * vectorScore + 0.2 * gnnScore + 0.1 * importanceScore
          const finalScore = 0.7 * result.score + 0.2 * gnnScore + 0.1 * Math.min(importance, 1);

          return { ...result, score: Math.min(1, finalScore) };
        })
      );

      reranked.sort((a, b) => b.score - a.score);
      return reranked.slice(0, limit);
    } catch {
      // Fallback to original ordering
      return results.slice(0, limit);
    }
  }

  /** Compute a GNN-enhanced similarity score for a single file */
  private async computeGnnScore(queryEmbedding: Float32Array, fileId: string): Promise<number> {
    if (!this.layer) return 0;

    // Get the file's own embedding from vector store
    const entry = await this.vectorStore.get(fileId);
    if (!entry) return 0;

    const fileEmbedding = Array.from(entry.vector);

    // Get neighbors from knowledge graph
    const neighbors = await this.graph.getRelatedFiles(fileId, 5);
    if (neighbors.length === 0) {
      // No neighbors — just return cosine similarity of original embedding
      return this.cosineSimilarity(
        Array.from(queryEmbedding),
        fileEmbedding,
      );
    }

    // Fetch neighbor embeddings and edge weights
    const neighborEmbeddings: number[][] = [];
    const edgeWeights: number[] = [];

    for (const neighbor of neighbors) {
      const neighborEntry = await this.vectorStore.get(neighbor.id);
      if (neighborEntry) {
        neighborEmbeddings.push(Array.from(neighborEntry.vector));
        // Use importance score as edge weight (fallback to graph weight)
        const importance = this.metadataDb.getImportance(neighbor.id);
        edgeWeights.push(importance > 0 ? importance : neighbor.weight);
      }
    }

    if (neighborEmbeddings.length === 0) {
      return this.cosineSimilarity(Array.from(queryEmbedding), fileEmbedding);
    }

    // GNN forward pass: aggregate neighbor info into file embedding
    const enhanced = this.layer.forward(fileEmbedding, neighborEmbeddings, edgeWeights);

    // Cosine similarity between query and GNN-enhanced embedding
    return this.cosineSimilarity(Array.from(queryEmbedding), enhanced);
  }

  /** Compute cosine similarity between two vectors */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }
}
