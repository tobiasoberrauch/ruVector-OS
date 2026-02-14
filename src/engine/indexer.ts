import { EventEmitter } from 'events';
import type { WatcherEvent, IndexedFile } from '../shared/types.js';
import type { VectorStore } from './vector-store.js';
import type { MetadataDb } from './metadata-db.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { OnnxEmbedder } from '../embeddings/onnx-embedder.js';
import type { ContentExtractor } from './content-extractor.js';
import type { Chunker } from './chunker.js';
import type { Chunk, StoredChunk } from '../shared/types.js';
import { createFileRecord, contentHash, fileId } from '../shared/utils.js';
import { basename, extname } from 'path';

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
    chunksEmbedded: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
  };

  private contentExtractor: ContentExtractor | null = null;
  private chunker: Chunker | null = null;

  constructor(
    private vectorStore: VectorStore,
    private metadataDb: MetadataDb,
    private graph: KnowledgeGraph,
    private embedder: OnnxEmbedder,
  ) {
    super();
  }

  /** Set a ContentExtractor for structured extraction (Phase 2) */
  setContentExtractor(extractor: ContentExtractor): void {
    this.contentExtractor = extractor;
  }

  /** Set a Chunker for multi-vector indexing (Phase 2) */
  setChunker(chunker: Chunker): void {
    this.chunker = chunker;
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
      // Start processing, and ensure timer is restarted if more items arrive
      this.processBatch().then(() => {
        // Restart timer if items were added during processing
        if (this.queue.length > 0 && !this.batchTimer && !this.processing) {
          this.batchTimer = setTimeout(async () => {
            this.batchTimer = null;
            // Guard: processBatch() checks this.processing at entry, but we double-check
            // here to prevent race where processBatch() might start between line 80 and 81
            if (this.processing) return;
            try {
              await this.processBatch();
            } catch (error) {
              console.error('Error in timer batch processing:', error);
              this.emit('error', error);
            }
          }, this.batchDelay);
        }
      }).catch((error) => {
        console.error('Error in batch processing:', error);
        this.emit('error', error);
      });
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
      // File deleted — remove all chunks and metadata
      this.metadataDb.deleteFileByPath(event.path);
      this.metadataDb.clearFileChunks(id);
      this.metadataDb.clearFileMetadata(id);
      const deleted = await this.vectorStore.deleteByPrefix(id);
      this.stats.chunksDeleted += deleted;
      await this.graph.removeFileNode(id);
      this.stats.deleted++;
      this.emit('deleted', event.path);
      return;
    }

    // File added or changed — extract content
    let content: string;
    let extractedMetadata: Record<string, string> = {};

    if (this.contentExtractor) {
      const extraction = await this.contentExtractor.extract(event.path);
      content = extraction.content;
      extractedMetadata = extraction.metadata;
    } else {
      // Legacy fallback: use extractContent from utils
      const { extractContent } = await import('../shared/utils.js');
      content = await extractContent(event.path);
    }

    if (!content.trim()) return; // Skip empty files

    // Optimization: Check if file exists and content hasn't changed
    // This avoids expensive hash computation in the update case where content is identical
    // If content has changed, we reuse the computed hash to avoid double computation
    const existing = this.metadataDb.getFileByPath(event.path);
    let computedHash: string | undefined;
    
    if (existing) {
      computedHash = contentHash(content);
      if (existing.contentHash === computedHash) {
        return; // Content unchanged, skip embedding
      }
    }

    // Create file record (pass hash if already computed, otherwise it will compute)
    const record = await createFileRecord(event.path, content, computedHash);

    // Store metadata
    this.metadataDb.upsertFile(record);

    // Chunked or single-vector embedding
    if (this.chunker) {
      await this.processChunked(record, content, event.path);
    } else {
      // Legacy single-vector path
      const start = performance.now();
      const vector = await this.embedder.embed(content);
      const embeddingTime = performance.now() - start;
      this.stats.totalEmbeddingTime += embeddingTime;

      await this.vectorStore.upsert(record.id, vector, {
        path: record.path,
        name: record.name,
        extension: record.extension,
        modifiedAt: record.modifiedAt,
      });
    }

    // Store extracted metadata (frontmatter, etc.)
    if (Object.keys(extractedMetadata).length > 0) {
      this.metadataDb.setFileMetadataBulk(record.id, extractedMetadata);
    }

    // Update knowledge graph
    await this.graph.addFileNode(record.id, record.name, {
      path: record.path,
      extension: record.extension,
    });

    // Extract simple concepts from filename and path
    const concepts = this.extractConcepts(record);

    // Add frontmatter tags as concepts
    if (extractedMetadata.tags) {
      for (const tag of extractedMetadata.tags.split(',').map(t => t.trim()).filter(Boolean)) {
        concepts.push(tag.toLowerCase());
      }
    }

    // Store title in graph metadata if available
    if (extractedMetadata.title) {
      await this.graph.addFileNode(record.id, extractedMetadata.title, {
        path: record.path,
        extension: record.extension,
        title: extractedMetadata.title,
      });
    }

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

  /** Process a file using chunking — embed each chunk separately */
  private async processChunked(record: IndexedFile, content: string, filePath: string): Promise<void> {
    const ext = extname(filePath);
    const chunks = this.chunker!.chunk(content, ext);

    if (chunks.length === 0) return;

    // Compare with stored chunks to find what changed
    const storedChunks = this.metadataDb.getFileChunks(record.id);
    const storedMap = new Map(storedChunks.map(c => [c.chunkIndex, c]));

    // Delete old chunks that no longer exist (file shrank)
    const oldMaxIndex = storedChunks.length > 0
      ? Math.max(...storedChunks.map(c => c.chunkIndex))
      : -1;
    for (let i = chunks.length; i <= oldMaxIndex; i++) {
      await this.vectorStore.delete(`${record.id}:${i}`);
      this.stats.chunksDeleted++;
    }

    // Embed new/changed chunks
    const newStoredChunks: StoredChunk[] = [];
    const chunkVectors: Array<{ index: number; vector: Float32Array; metadata: Record<string, unknown> }> = [];

    for (const chunk of chunks) {
      const chunkHash = contentHash(chunk.text);
      const stored = storedMap.get(chunk.index);

      newStoredChunks.push({
        fileId: record.id,
        chunkIndex: chunk.index,
        contentHash: chunkHash,
        label: chunk.label ?? '',
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });

      // Skip embedding if chunk content hasn't changed
      if (stored && stored.contentHash === chunkHash) {
        this.stats.chunksSkipped++;
        continue;
      }

      // Embed this chunk
      const start = performance.now();
      const vector = await this.embedder.embed(chunk.text);
      const embeddingTime = performance.now() - start;
      this.stats.totalEmbeddingTime += embeddingTime;
      this.stats.chunksEmbedded++;

      chunkVectors.push({
        index: chunk.index,
        vector,
        metadata: {
          path: record.path,
          name: record.name,
          extension: record.extension,
          modifiedAt: record.modifiedAt,
          chunkLabel: chunk.label ?? '',
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
      });
    }

    // Store chunk vectors
    if (chunkVectors.length > 0) {
      await this.vectorStore.upsertChunks(record.id, chunkVectors);
    }

    // Update stored chunk metadata
    this.metadataDb.upsertFileChunks(record.id, newStoredChunks);
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

    return Array.from(concepts);
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
