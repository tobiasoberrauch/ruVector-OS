import { writeFile, unlink } from 'fs/promises';
import { EventEmitter } from 'events';
import { FSWatcher } from '../watcher/fs-watcher.js';
import { OnnxEmbedder } from '../embeddings/onnx-embedder.js';
import { VectorStore } from '../engine/vector-store.js';
import { MetadataDb } from '../engine/metadata-db.js';
import { KnowledgeGraph } from '../engine/knowledge-graph.js';
import { Indexer } from '../engine/indexer.js';
import { SearchEngine } from '../engine/search.js';
import { LearningEngine } from '../engine/learning-engine.js';
import { GnnRanker } from '../engine/gnn-ranker.js';
import { SimilaritySweep } from '../engine/similarity-sweep.js';
import { QueryExpander } from '../engine/query-expander.js';
import { ContextTracker } from '../engine/context-tracker.js';
import { AutoTagger } from '../engine/auto-tagger.js';
import { loadConfig, saveConfig } from './config.js';
import { PID_FILE } from '../shared/paths.js';
import type { RuvectorConfig, DaemonStatus, SearchQuery, SearchResultWithTracking, WatcherEvent, LearningMetrics } from '../shared/types.js';

/**
 * Main daemon orchestrator.
 * Manages the lifecycle of all subsystems:
 * watcher → indexer → embedder → vector store → knowledge graph
 * + learning engine → GNN ranker → similarity sweep (Tier 2)
 * + query expander → context tracker → auto-tagger (Tier 3)
 */
export class RuvectorDaemon extends EventEmitter {
  private config!: RuvectorConfig;
  private watcher!: FSWatcher;
  private embedder!: OnnxEmbedder;
  private vectorStore!: VectorStore;
  private metadataDb!: MetadataDb;
  private graph!: KnowledgeGraph;
  private indexer!: Indexer;
  private searchEngine!: SearchEngine;
  private learningEngine!: LearningEngine;
  private gnnRanker!: GnnRanker;
  private sweep!: SimilaritySweep;
  private queryExpander!: QueryExpander;
  private contextTracker!: ContextTracker;
  private autoTagger!: AutoTagger;
  private startTime = 0;
  private shuttingDown = false;

  /** Initialize all subsystems */
  async init(): Promise<void> {
    this.config = await loadConfig();

    // Initialize core components
    this.metadataDb = new MetadataDb();
    await this.metadataDb.init();

    this.vectorStore = new VectorStore(this.config.dimensions);
    await this.vectorStore.init();

    this.graph = new KnowledgeGraph();
    await this.graph.init();

    this.embedder = new OnnxEmbedder(this.config.modelIdleTimeout);

    // Download model if needed
    if (!(await this.embedder.isModelDownloaded())) {
      await this.embedder.downloadModel((msg) => this.emit('log', msg));
    }

    this.indexer = new Indexer(
      this.vectorStore,
      this.metadataDb,
      this.graph,
      this.embedder,
    );

    this.searchEngine = new SearchEngine(
      this.vectorStore,
      this.metadataDb,
      this.graph,
      this.embedder,
    );

    // Initialize learning components (Tier 2)
    this.learningEngine = new LearningEngine(this.metadataDb, this.graph);

    this.gnnRanker = new GnnRanker(this.graph, this.metadataDb, this.vectorStore);
    await this.gnnRanker.init();

    this.sweep = new SimilaritySweep(
      this.metadataDb,
      this.vectorStore,
      this.graph,
    );

    // Initialize adaptive intelligence (Tier 3)
    this.queryExpander = new QueryExpander(this.metadataDb, this.embedder, this.vectorStore);
    this.contextTracker = new ContextTracker(this.metadataDb);
    this.autoTagger = new AutoTagger(this.metadataDb, this.vectorStore, this.embedder);

    // Wire learning into search
    this.searchEngine.setLearningComponents(this.learningEngine, this.gnnRanker);
    this.searchEngine.setAdaptiveComponents(this.queryExpander, this.contextTracker);

    // Decay importance scores on startup
    const pruned = this.learningEngine.decayAll();
    if (pruned > 0) {
      this.emit('log', `Learning: decayed scores, pruned ${pruned} entries`);
    }

    // Prune old context events on startup
    const contextPruned = this.contextTracker.prune();
    if (contextPruned > 0) {
      this.emit('log', `Context: pruned ${contextPruned} old events`);
    }

    this.watcher = new FSWatcher({
      extensions: this.config.indexExtensions,
      ignoreDirs: this.config.ignoreDirs,
      maxFileSize: this.config.maxFileSize,
    });

    // Wire events
    this.watcher.on('file-event', (event: WatcherEvent) => {
      this.indexer.enqueue(event);
      this.emit('file-event', event);
    });

    this.watcher.on('ready', (dir: string) => {
      this.emit('log', `Watching: ${dir}`);
    });

    this.watcher.on('error', (error: Error) => {
      this.emit('error', error);
    });

    this.indexer.on('indexed', (file: any) => {
      this.emit('indexed', file);
    });

    this.indexer.on('updated', (file: any) => {
      this.emit('updated', file);
    });

    this.indexer.on('deleted', (path: string) => {
      this.emit('deleted', path);
    });

    this.indexer.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Wire sweep events
    this.sweep.on('sweep-start', () => {
      this.emit('log', 'Similarity sweep started');
    });

    this.sweep.on('sweep-end', (stats: { filesProcessed: number; edgesCreated: number }) => {
      this.emit('log', `Similarity sweep complete: ${stats.filesProcessed} files, ${stats.edgesCreated} new edges`);
    });

    this.sweep.on('error', (err: Error) => {
      this.emit('error', err);
    });

    // Wire auto-tagger events
    this.autoTagger.on('tagging-start', () => {
      this.emit('log', 'Auto-tagging started');
    });

    this.autoTagger.on('tagging-end', (stats: { tagsCreated: number; filesTagged: number }) => {
      this.emit('log', `Auto-tagging complete: ${stats.tagsCreated} tags, ${stats.filesTagged} files tagged`);
    });
  }

  /** Start the daemon */
  async start(): Promise<void> {
    this.startTime = Date.now();

    // Write PID file
    await writeFile(PID_FILE, process.pid.toString(), 'utf-8');

    // Start watching configured directories
    for (const dir of this.config.watchDirs) {
      await this.watcher.watchDir(dir);
    }

    // Start similarity sweep timer
    this.sweep.start();

    // Mark as running
    this.config.running = true;
    await saveConfig(this.config);

    this.emit('started');
    this.emit('log', `Daemon started (PID ${process.pid})`);

    // Handle shutdown signals
    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /** Stop the daemon gracefully */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.emit('log', 'Shutting down...');

    // Stop similarity sweep
    this.sweep.stop();

    // Save GNN weights
    await this.gnnRanker.saveWeights();

    // Flush pending indexing
    await this.indexer.flush();

    // Close watcher
    await this.watcher.close();

    // Unload ONNX model
    this.embedder.unload();

    // Close database
    this.metadataDb.close();

    // Remove PID file
    try {
      await unlink(PID_FILE);
    } catch {
      // ignore
    }

    // Mark as stopped
    this.config.running = false;
    await saveConfig(this.config);

    this.emit('stopped');
  }

  /** Add a directory to watch */
  async addWatchDir(dir: string): Promise<void> {
    if (!this.config.watchDirs.includes(dir)) {
      this.config.watchDirs.push(dir);
      await saveConfig(this.config);
    }
    await this.watcher.watchDir(dir);
    this.emit('log', `Added watch: ${dir}`);
  }

  /** Remove a directory from watching */
  async removeWatchDir(dir: string): Promise<void> {
    this.config.watchDirs = this.config.watchDirs.filter(d => d !== dir);
    await saveConfig(this.config);
    await this.watcher.unwatchDir(dir);
    this.emit('log', `Removed watch: ${dir}`);
  }

  /** Perform a semantic search */
  async search(query: SearchQuery): Promise<SearchResultWithTracking[]> {
    return this.searchEngine.search(query);
  }

  /** Quick search (for autocomplete) */
  async quickSearch(text: string, limit = 5) {
    return this.searchEngine.quickSearch(text, limit);
  }

  /** Record a click on a search result */
  async recordClick(searchId: number, fileId: string, position: number): Promise<void> {
    await this.searchEngine.recordClick(searchId, fileId, position);
  }

  /** Get learning metrics */
  getLearningMetrics(): LearningMetrics {
    return this.learningEngine.getMetrics(
      this.sweep.getLastSweepTime(),
      this.sweep.getSweepFileCount(),
      this.gnnRanker.isActive(),
    );
  }

  /** Trigger a similarity sweep manually */
  async triggerSweep(): Promise<{ filesProcessed: number; edgesCreated: number }> {
    return this.sweep.runSweep();
  }

  /** Trigger auto-tagging manually */
  async triggerAutoTag(): Promise<{ tagsCreated: number; filesTagged: number }> {
    return this.autoTagger.runTagging();
  }

  /** Get all tags */
  getTags(): Array<{ id: string; label: string; fileCount: number }> {
    return this.metadataDb.getAllTags();
  }

  /** Get tags for a file */
  getFileTags(fileId: string): Array<{ tagId: string; label: string; confidence: number }> {
    return this.metadataDb.getFileTags(fileId);
  }

  /** Get files by tag */
  getFilesByTag(tagId: string): Array<{ fileId: string; confidence: number }> {
    return this.metadataDb.getFilesByTag(tagId);
  }

  /** Get search analytics */
  getSearchAnalytics(): {
    topQueries: Array<{ query: string; count: number; lastUsed: number }>;
    volumeByDay: Array<{ date: string; count: number }>;
    clickStats: { totalSearches: number; totalClicks: number; ctr: number };
  } {
    return {
      topQueries: this.metadataDb.getTopQueries(10),
      volumeByDay: this.metadataDb.getSearchVolumeByDay(14),
      clickStats: this.metadataDb.getSearchClickStats(),
    };
  }

  /** Reset all learning data */
  resetLearning(): void {
    this.learningEngine.reset();
  }

  /** Get daemon status */
  async getStatus(): Promise<DaemonStatus> {
    const graphStats = await this.graph.getStats();
    const mem = process.memoryUsage();
    const dbStats = this.metadataDb.getStats();

    return {
      running: !this.shuttingDown,
      pid: process.pid,
      uptime: Date.now() - this.startTime,
      indexedFiles: dbStats.files,
      totalVectors: dbStats.files,  // 1:1 with files for now
      graphNodes: graphStats.nodes,
      graphEdges: graphStats.edges,
      watchedDirs: this.watcher.getWatchedDirs(),
      memoryUsage: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      storageSize: dbStats.dbSize,
      lastActivity: Date.now(),
    };
  }

  /** Get config */
  getConfig(): RuvectorConfig {
    return { ...this.config };
  }

  /** Get the search engine (for MCP server) */
  getSearchEngine(): SearchEngine {
    return this.searchEngine;
  }

  /** Get the metadata DB (for MCP server) */
  getMetadataDb(): MetadataDb {
    return this.metadataDb;
  }

  /** Get the knowledge graph (for visualization) */
  getGraph(): KnowledgeGraph {
    return this.graph;
  }

  /** Get indexer stats */
  getIndexerStats() {
    return this.indexer.getStats();
  }
}
