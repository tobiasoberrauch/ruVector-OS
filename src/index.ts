/** RuVector OS — System-level intelligence layer for macOS */

export { RuvectorDaemon } from './daemon/daemon.js';
export { OnnxEmbedder } from './embeddings/onnx-embedder.js';
export { VectorStore } from './engine/vector-store.js';
export { MetadataDb } from './engine/metadata-db.js';
export { KnowledgeGraph } from './engine/knowledge-graph.js';
export { SearchEngine } from './engine/search.js';
export { Indexer } from './engine/indexer.js';
export { LearningEngine } from './engine/learning-engine.js';
export { GnnRanker } from './engine/gnn-ranker.js';
export { SimilaritySweep } from './engine/similarity-sweep.js';
export { QueryExpander } from './engine/query-expander.js';
export { ContextTracker } from './engine/context-tracker.js';
export { AutoTagger } from './engine/auto-tagger.js';
export { FSWatcher } from './watcher/fs-watcher.js';
export { DashboardServer } from './dashboard/server.js';
export { RuvectorMcpServer } from './mcp/server.js';

export type {
  RuvectorConfig,
  IndexedFile,
  SearchResult,
  SearchResultWithTracking,
  SearchQuery,
  DaemonStatus,
  WatcherEvent,
  GraphNode,
  GraphEdge,
  LearningMetrics,
} from './shared/types.js';
