import { EventEmitter } from 'events';
import type { MetadataDb } from './metadata-db.js';
import type { VectorStore } from './vector-store.js';
import type { OnnxEmbedder } from '../embeddings/onnx-embedder.js';

const MAX_CLUSTERS = 20;
const MIN_CLUSTER_SIZE = 3;
const SIMILARITY_THRESHOLD = 0.65;
const SAMPLE_SIZE = 200;

/**
 * Auto-tagger for Tier 3.
 *
 * Clusters indexed files by embedding similarity and assigns topic tags.
 * Uses a simple centroid-based clustering approach:
 * 1. Sample file embeddings from the vector store
 * 2. Build clusters by iteratively assigning files to nearest centroid
 * 3. Label clusters based on common file names/extensions
 * 4. Store tags in metadata DB
 */
export class AutoTagger extends EventEmitter {
  constructor(
    private metadataDb: MetadataDb,
    private vectorStore: VectorStore,
    private embedder: OnnxEmbedder,
  ) {
    super();
  }

  /**
   * Run auto-tagging on all indexed files.
   * Returns the number of tags created and files tagged.
   */
  async runTagging(): Promise<{ tagsCreated: number; filesTagged: number }> {
    this.emit('tagging-start');

    const allIds = this.metadataDb.getAllFileIds();
    if (allIds.length < MIN_CLUSTER_SIZE) {
      this.emit('tagging-end', { tagsCreated: 0, filesTagged: 0 });
      return { tagsCreated: 0, filesTagged: 0 };
    }

    // Sample files
    const sampleIds = this.sampleArray(allIds, SAMPLE_SIZE);

    // Fetch embeddings
    const fileEmbeddings: Array<{ id: string; vector: Float32Array }> = [];
    for (const id of sampleIds) {
      const entry = await this.vectorStore.get(id);
      if (entry) {
        fileEmbeddings.push({ id, vector: entry.vector });
      }
    }

    if (fileEmbeddings.length < MIN_CLUSTER_SIZE) {
      this.emit('tagging-end', { tagsCreated: 0, filesTagged: 0 });
      return { tagsCreated: 0, filesTagged: 0 };
    }

    // Cluster files
    const clusters = this.clusterFiles(fileEmbeddings);

    // Create tags and assign
    let tagsCreated = 0;
    let filesTagged = 0;

    for (const cluster of clusters) {
      if (cluster.members.length < MIN_CLUSTER_SIZE) continue;

      // Generate label from most common file characteristics
      const label = this.generateClusterLabel(cluster.members);
      const tagId = this.metadataDb.upsertTag(label);
      tagsCreated++;

      // Assign tag to all cluster members
      for (const member of cluster.members) {
        this.metadataDb.tagFile(member.id, tagId, member.similarity);
        filesTagged++;
      }

      this.emit('tagging-progress', { tag: label, files: cluster.members.length });
    }

    this.emit('tagging-end', { tagsCreated, filesTagged });
    return { tagsCreated, filesTagged };
  }

  /**
   * Simple centroid-based clustering.
   * Seeds centroids by picking the most distant points, then assigns files to nearest.
   */
  private clusterFiles(
    files: Array<{ id: string; vector: Float32Array }>,
  ): Array<{ centroid: Float32Array; members: Array<{ id: string; similarity: number }> }> {
    const k = Math.min(MAX_CLUSTERS, Math.max(2, Math.floor(files.length / MIN_CLUSTER_SIZE)));

    // Seed centroids using k-means++ style selection
    const centroids: Float32Array[] = [];
    const usedIndices = new Set<number>();

    // First centroid: random
    const firstIdx = Math.floor(Math.random() * files.length);
    centroids.push(new Float32Array(files[firstIdx].vector));
    usedIndices.add(firstIdx);

    // Remaining centroids: pick the point furthest from existing centroids
    while (centroids.length < k) {
      let maxDist = -1;
      let bestIdx = 0;
      for (let i = 0; i < files.length; i++) {
        if (usedIndices.has(i)) continue;
        let minDist = Infinity;
        for (const c of centroids) {
          const dist = 1 - this.cosineSimilarity(files[i].vector, c);
          minDist = Math.min(minDist, dist);
        }
        if (minDist > maxDist) {
          maxDist = minDist;
          bestIdx = i;
        }
      }
      centroids.push(new Float32Array(files[bestIdx].vector));
      usedIndices.add(bestIdx);
    }

    // Assign files to nearest centroid (2 iterations)
    let assignments = new Array(files.length).fill(0);

    for (let iter = 0; iter < 2; iter++) {
      // Assign
      for (let i = 0; i < files.length; i++) {
        let bestCluster = 0;
        let bestSim = -1;
        for (let c = 0; c < centroids.length; c++) {
          const sim = this.cosineSimilarity(files[i].vector, centroids[c]);
          if (sim > bestSim) {
            bestSim = sim;
            bestCluster = c;
          }
        }
        assignments[i] = bestCluster;
      }

      // Recompute centroids
      const dim = centroids[0].length;
      for (let c = 0; c < centroids.length; c++) {
        const newCentroid = new Float32Array(dim);
        let count = 0;
        for (let i = 0; i < files.length; i++) {
          if (assignments[i] === c) {
            for (let d = 0; d < dim; d++) {
              newCentroid[d] += files[i].vector[d];
            }
            count++;
          }
        }
        if (count > 0) {
          for (let d = 0; d < dim; d++) {
            newCentroid[d] /= count;
          }
          centroids[c] = newCentroid;
        }
      }
    }

    // Build cluster result
    const clusters: Array<{ centroid: Float32Array; members: Array<{ id: string; similarity: number }> }> = [];
    for (let c = 0; c < centroids.length; c++) {
      const members: Array<{ id: string; similarity: number }> = [];
      for (let i = 0; i < files.length; i++) {
        if (assignments[i] === c) {
          const sim = this.cosineSimilarity(files[i].vector, centroids[c]);
          if (sim >= SIMILARITY_THRESHOLD) {
            members.push({ id: files[i].id, similarity: sim });
          }
        }
      }
      if (members.length >= MIN_CLUSTER_SIZE) {
        clusters.push({ centroid: centroids[c], members });
      }
    }

    return clusters;
  }

  /** Generate a human-readable label for a cluster based on file characteristics */
  private generateClusterLabel(members: Array<{ id: string; similarity: number }>): string {
    const extCounts = new Map<string, number>();
    const dirCounts = new Map<string, number>();
    const words = new Map<string, number>();

    for (const member of members) {
      const file = this.metadataDb.getFile(member.id);
      if (!file) continue;

      // Count extensions
      extCounts.set(file.extension, (extCounts.get(file.extension) ?? 0) + 1);

      // Count parent directory names
      const parts = file.path.split('/');
      if (parts.length >= 2) {
        const dir = parts[parts.length - 2];
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }

      // Extract words from file name
      const nameWords = file.name.replace(/\.[^.]+$/, '').split(/[-_. ]+/);
      for (const w of nameWords) {
        if (w.length > 2) {
          const lower = w.toLowerCase();
          words.set(lower, (words.get(lower) ?? 0) + 1);
        }
      }
    }

    // Pick the most common characteristic
    const topExt = this.topEntry(extCounts);
    const topDir = this.topEntry(dirCounts);
    const topWord = this.topEntry(words);

    // Build label
    const parts: string[] = [];
    if (topDir && topDir[1] >= members.length * 0.4) {
      parts.push(topDir[0]);
    }
    if (topWord && topWord[1] >= 2) {
      parts.push(topWord[0]);
    }
    if (topExt) {
      parts.push(topExt[0].replace('.', ''));
    }

    if (parts.length === 0) {
      return `cluster-${members.length}`;
    }

    return parts.slice(0, 3).join('-');
  }

  private topEntry(map: Map<string, number>): [string, number] | null {
    let best: [string, number] | null = null;
    for (const [k, v] of map) {
      if (!best || v > best[1]) best = [k, v];
    }
    return best;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private sampleArray<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return [...arr];
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, n);
  }
}
