import { EventEmitter } from 'events';
import type { WatcherEvent, IndexedFile } from '../shared/types.js';
import type { VectorStore } from './vector-store.js';
import type { MetadataDb } from './metadata-db.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { OnnxEmbedder } from '../embeddings/onnx-embedder.js';
import { extractContent, createFileRecord, contentHash, fileId } from '../shared/utils.js';
import { basename } from 'path';

/**
 * Indexing pipeline:
 * File event → extract content → compute embedding → store vector → update graph
 *
 * Processes events in batches to reduce ONNX model load/unload cycles.
 */
export class Indexer extends EventEmitter {
  private queue: WatcherEvent[] = [];
  private processing = false;
  private batchSize = 10;
  private batchDelay = 500; // ms
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  private stats = {
    indexed: 0,
    updated: 0,
    deleted: 0,
    errors: 0,
    totalEmbeddingTime: 0,
  };

  constructor(
    private vectorStore: VectorStore,
    private metadataDb: MetadataDb,
    private graph: KnowledgeGraph,
    private embedder: OnnxEmbedder,
  ) {
    super();
  }

  /** Queue a file event for processing */
  enqueue(event: WatcherEvent): void {
    this.queue.push(event);

    // Start batch timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.processBatch();
      }, this.batchDelay);
    }

    // Process immediately if batch is full
    if (this.queue.length >= this.batchSize) {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      }
      this.processBatch();
    }
  }

  /** Process pending events */
  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const batch = this.queue.splice(0, this.batchSize);

    try {
      for (const event of batch) {
        await this.processEvent(event);
      }
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
    } finally {
      this.processing = false;
      // Process more if queued
      if (this.queue.length > 0) {
        this.processBatch();
      }
    }
  }

  private async processEvent(event: WatcherEvent): Promise<void> {
    const id = fileId(event.path);

    if (event.type === 'unlink') {
      // File deleted
      this.metadataDb.deleteFileByPath(event.path);
      await this.vectorStore.delete(id);
      await this.graph.removeFileNode(id);
      this.stats.deleted++;
      this.emit('deleted', event.path);
      return;
    }

    // File added or changed — extract content
    const content = await extractContent(event.path);
    if (!content.trim()) return; // Skip empty files

    // Check if content actually changed (avoid re-embedding identical content)
    const existing = this.metadataDb.getFileByPath(event.path);
    const hash = contentHash(content);
    if (existing && existing.contentHash === hash) {
      return; // Content unchanged, skip embedding
    }

    // Create file record
    const record = await createFileRecord(event.path, content);

    // Compute embedding
    const start = performance.now();
    const vector = await this.embedder.embed(content);
    const embeddingTime = performance.now() - start;
    this.stats.totalEmbeddingTime += embeddingTime;

    // Store in vector index
    await this.vectorStore.upsert(record.id, vector, {
      path: record.path,
      name: record.name,
      extension: record.extension,
      modifiedAt: record.modifiedAt,
    });

    // Store metadata
    this.metadataDb.upsertFile(record);

    // Update knowledge graph
    await this.graph.addFileNode(record.id, record.name, {
      path: record.path,
      extension: record.extension,
    });

    // Extract simple concepts from filename and path
    const concepts = this.extractConcepts(record);
    for (const concept of concepts) {
      const conceptId = `concept:${concept}`;
      await this.graph.addConceptNode(conceptId, concept);
      await this.graph.connectFileToConcept(record.id, conceptId);
    }

    if (event.type === 'add') {
      this.stats.indexed++;
      this.emit('indexed', record);
    } else {
      this.stats.updated++;
      this.emit('updated', record);
    }
  }

  /** Extract concept keywords from a file record */
  private extractConcepts(file: IndexedFile): string[] {
    const concepts: Set<string> = new Set();

    // From filename (split camelCase, kebab-case, snake_case)
    const nameParts = file.name
      .replace(/\.[^.]+$/, '')  // Remove extension
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
      .replace(/[-_\.]/g, ' ')  // kebab/snake/dot
      .toLowerCase()
      .split(/\s+/)
      .filter(p => p.length > 2);

    for (const part of nameParts) {
      concepts.add(part);
    }

    // From path segments
    const pathParts = file.path
      .split('/')
      .filter(p => p.length > 2 && !p.startsWith('.'))
      .slice(-3);  // Last 3 path segments

    for (const part of pathParts) {
      if (part !== file.name) {
        concepts.add(part.toLowerCase());
      }
    }

    // File type concept
    if (file.extension) {
      const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rs': 'rust', '.go': 'golang', '.java': 'java',
        '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
        '.md': 'markdown', '.html': 'html', '.css': 'css', '.sql': 'sql',
      };
      const lang = langMap[file.extension];
      if (lang) concepts.add(lang);
    }

    return [...concepts];
  }

  /** Get indexer stats */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      avgEmbeddingTime: this.stats.indexed > 0
        ? this.stats.totalEmbeddingTime / (this.stats.indexed + this.stats.updated)
        : 0,
    };
  }

  /** Flush the queue (process all pending events) */
  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    while (this.queue.length > 0 || this.processing) {
      if (!this.processing) {
        await this.processBatch();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
