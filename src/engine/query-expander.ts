import type { MetadataDb } from './metadata-db.js';
import type { OnnxEmbedder } from '../embeddings/onnx-embedder.js';
import type { VectorStore } from './vector-store.js';

/**
 * Query expansion for Tier 3.
 *
 * When a search yields too few results, expands the query using:
 * 1. Past queries that led to clicks on the same files
 * 2. Embedding-space nearest-neighbor queries from search history
 *
 * The expanded query is a weighted combination: original query + related terms.
 */
export class QueryExpander {
  private minResultsForExpansion = 3;

  constructor(
    private metadataDb: MetadataDb,
    private embedder: OnnxEmbedder,
    private vectorStore: VectorStore,
  ) {}

  /**
   * Expand a query if needed.
   * Returns an array of expanded query strings to search with.
   * The first entry is always the original query.
   */
  async expand(
    originalQuery: string,
    resultCount: number,
    resultFileIds: string[],
  ): Promise<string[]> {
    // Only expand if we got fewer results than the threshold
    if (resultCount >= this.minResultsForExpansion) {
      return [originalQuery];
    }

    const expanded: string[] = [originalQuery];

    // Strategy 1: Find past queries that led to clicks on the same files
    const relatedQueries = this.metadataDb.getSimilarQueries(
      resultFileIds,
      originalQuery,
      3,
    );
    for (const q of relatedQueries) {
      if (!expanded.includes(q)) {
        expanded.push(q);
      }
    }

    // Strategy 2: Find semantically similar past queries via embedding
    try {
      const topQueries = this.metadataDb.getTopQueries(20);
      if (topQueries.length > 0) {
        const queryEmbedding = await this.embedder.embed(originalQuery);
        const candidates = await Promise.all(
          topQueries
            .filter(q => q.query !== originalQuery)
            .slice(0, 10)
            .map(async (q) => {
              const emb = await this.embedder.embed(q.query);
              const sim = this.cosineSimilarity(queryEmbedding, emb);
              return { query: q.query, similarity: sim };
            })
        );

        // Take queries with similarity > 0.5 that we haven't already added
        candidates
          .filter(c => c.similarity > 0.5)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 2)
          .forEach(c => {
            if (!expanded.includes(c.query)) {
              expanded.push(c.query);
            }
          });
      }
    } catch {
      // Embedding failure — skip this strategy
    }

    return expanded;
  }

  /**
   * Combine multiple query embeddings into a weighted mean.
   * The original query gets weight 1.0, expansions get 0.3 each.
   */
  async combineEmbeddings(queries: string[]): Promise<Float32Array> {
    if (queries.length === 0) {
      throw new Error('No queries to combine');
    }
    if (queries.length === 1) {
      return this.embedder.embed(queries[0]);
    }

    const embeddings = await Promise.all(queries.map(q => this.embedder.embed(q)));
    const dim = embeddings[0].length;
    const combined = new Float32Array(dim);

    // Weighted combination: original = 1.0, expansions = 0.3
    const weights = [1.0, ...Array(embeddings.length - 1).fill(0.3)];
    let totalWeight = 0;

    for (let i = 0; i < embeddings.length; i++) {
      const w = weights[i];
      totalWeight += w;
      for (let d = 0; d < dim; d++) {
        combined[d] += embeddings[i][d] * w;
      }
    }

    // Normalize
    for (let d = 0; d < dim; d++) {
      combined[d] /= totalWeight;
    }

    // L2 normalize the combined vector
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      norm += combined[d] * combined[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < dim; d++) {
        combined[d] /= norm;
      }
    }

    return combined;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
