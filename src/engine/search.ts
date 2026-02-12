import type { SearchQuery, SearchResult, SearchResultWithTracking, IndexedFile } from '../shared/types.js';
import type { VectorStore } from './vector-store.js';
import type { MetadataDb } from './metadata-db.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { OnnxEmbedder } from '../embeddings/onnx-embedder.js';
import type { LearningEngine } from './learning-engine.js';
import type { GnnRanker } from './gnn-ranker.js';
import type { QueryExpander } from './query-expander.js';
import type { ContextTracker } from './context-tracker.js';

/**
 * Unified search engine combining:
 * - Vector similarity (HNSW cosine search)
 * - Knowledge graph traversal (related files)
 * - Recency weighting (newer files score slightly higher)
 * - GNN re-ranking (Tier 2 learning)
 * - Click tracking (Tier 2 learning)
 * - Query expansion (Tier 3 adaptive)
 * - Context boost (Tier 3 adaptive)
 */
export class SearchEngine {
  private learningEngine: LearningEngine | null = null;
  private gnnRanker: GnnRanker | null = null;
  private queryExpander: QueryExpander | null = null;
  private contextTracker: ContextTracker | null = null;

  constructor(
    private vectorStore: VectorStore,
    private metadataDb: MetadataDb,
    private graph: KnowledgeGraph,
    private embedder: OnnxEmbedder,
  ) {}

  /** Attach learning components (Tier 2) */
  setLearningComponents(learning: LearningEngine, gnn: GnnRanker): void {
    this.learningEngine = learning;
    this.gnnRanker = gnn;
  }

  /** Attach adaptive intelligence components (Tier 3) */
  setAdaptiveComponents(expander: QueryExpander, context: ContextTracker): void {
    this.queryExpander = expander;
    this.contextTracker = context;
  }

  /** Perform a semantic search with full pipeline */
  async search(query: SearchQuery): Promise<SearchResultWithTracking[]> {
    // 1. Embed the query
    const queryVector = await this.embedder.embed(query.query);

    // 2. Vector similarity search
    let vectorResults = await this.vectorStore.search(
      queryVector,
      query.limit * 2,  // Fetch extra for filtering/reranking
      query.threshold,
    );

    // 2b. Query expansion: if too few results, expand and re-search
    if (this.queryExpander && vectorResults.length < 3) {
      try {
        const expanded = await this.queryExpander.expand(
          query.query,
          vectorResults.length,
          vectorResults.map(r => r.id),
        );
        if (expanded.length > 1) {
          const expandedVector = await this.queryExpander.combineEmbeddings(expanded);
          const expandedResults = await this.vectorStore.search(
            expandedVector,
            query.limit * 2,
            query.threshold * 0.8, // Slightly lower threshold for expansion
          );
          // Merge: keep originals, add new ones with slightly lower scores
          const existingIds = new Set(vectorResults.map(r => r.id));
          for (const er of expandedResults) {
            if (!existingIds.has(er.id)) {
              vectorResults.push({ ...er, score: er.score * 0.9 }); // Slight penalty for expansion
            }
          }
        }
      } catch {
        // Expansion failed; continue with original results
      }
    }

    // 3. Build results with metadata
    const results: SearchResult[] = [];
    for (const vr of vectorResults) {
      const file = this.metadataDb.getFile(vr.id);
      if (!file) continue;

      // Apply filters
      if (query.extensions && !query.extensions.includes(file.extension)) continue;
      if (query.directory && !file.path.startsWith(query.directory)) continue;

      // Recency boost: files modified in the last 7 days get up to 10% boost
      const daysSinceModified = (Date.now() - file.modifiedAt) / (1000 * 60 * 60 * 24);
      const recencyBoost = daysSinceModified < 7 ? 0.1 * (1 - daysSinceModified / 7) : 0;

      // Context boost (Tier 3): files in active working context get a boost
      const contextBoost = this.contextTracker
        ? this.contextTracker.getContextBoost(file.id, file.path) * 0.1
        : 0;

      const finalScore = Math.min(1, vr.score + recencyBoost + contextBoost);

      // Get related files from knowledge graph
      const relatedRaw = await this.graph.getRelatedFiles(file.id, 3);
      const relatedFiles = relatedRaw
        .map(r => this.metadataDb.getFile(r.id))
        .filter((f): f is IndexedFile => f !== null);

      // Attach tags if available
      const tags = this.metadataDb.getFileTags(file.id);

      results.push({
        file,
        score: finalScore,
        snippet: file.contentPreview,
        relatedFiles,
        tags: tags.length > 0 ? tags.map(t => t.label) : undefined,
      });
    }

    // 4. Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // 5. GNN re-ranking (if available)
    let finalResults: SearchResult[];
    if (this.gnnRanker?.isActive()) {
      finalResults = await this.gnnRanker.rerank(queryVector, results, query.limit);
    } else {
      finalResults = results.slice(0, query.limit);
    }

    // 6. Log the search and get a searchId for click tracking
    const searchId = this.metadataDb.logSearchWithId(
      query.query,
      finalResults.map(r => r.file.id)
    );

    // 7. Increment shown counts for learning
    this.metadataDb.incrementShownCount(finalResults.map(r => r.file.id));

    // 8. Record context events for shown results
    if (this.contextTracker) {
      for (const r of finalResults) {
        this.contextTracker.recordSearchResult(r.file.id);
      }
    }

    // 9. Attach searchId to results
    return finalResults.map(r => ({ ...r, searchId }));
  }

  /** Record a click on a search result */
  async recordClick(searchId: number, fileId: string, position: number): Promise<void> {
    // Record for learning
    if (this.learningEngine) {
      await this.learningEngine.recordClick(searchId, fileId, position);
    } else {
      this.metadataDb.recordClick(searchId, fileId, position);
    }

    // Record for context tracking
    if (this.contextTracker) {
      this.contextTracker.recordAccess(fileId);
    }
  }

  /** Quick search without graph traversal (faster, for autocomplete) */
  async quickSearch(queryText: string, limit = 5): Promise<Array<{ file: IndexedFile; score: number }>> {
    const queryVector = await this.embedder.embed(queryText);
    const results = await this.vectorStore.search(queryVector, limit, 0.3);

    return results
      .map(vr => {
        const file = this.metadataDb.getFile(vr.id);
        if (!file) return null;
        return { file, score: vr.score };
      })
      .filter((r): r is { file: IndexedFile; score: number } => r !== null);
  }
}
