import { GraphDatabase, type JsGraphStats } from '@ruvector/graph-node';
import { GRAPH_DIR } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';
import { join } from 'path';

/**
 * Knowledge graph for file -> concept -> connection relationships.
 * Built on @ruvector/graph-node (native Rust) with Cypher queries.
 *
 * Falls back to an in-memory adjacency list if the native graph
 * fails to initialize.
 */
export class KnowledgeGraph {
  private graph: GraphDatabase | null = null;
  private dimensions = 384;

  // Fallback in-memory store
  private fallbackNodes: Map<string, { type: string; label: string; metadata: Record<string, unknown> }> = new Map();
  private fallbackEdges: Array<{ source: string; target: string; type: string; weight: number }> = [];
  private useFallback = false;

  async init(): Promise<void> {
    await ensureDir(GRAPH_DIR);

    try {
      this.graph = new GraphDatabase({
        distanceMetric: 'Cosine' as any,
        dimensions: this.dimensions,
        storagePath: join(GRAPH_DIR, 'knowledge.db'),
      });
    } catch {
      // Native bindings not available, use fallback
      this.useFallback = true;
    }
  }

  /** Add a file node to the graph */
  async addFileNode(id: string, label: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (this.useFallback || !this.graph) {
      this.fallbackNodes.set(id, { type: 'file', label, metadata });
      return;
    }
    try {
      await this.graph.createNode({
        id,
        embedding: new Float32Array(this.dimensions), // Zero embedding placeholder
        labels: ['file'],
        properties: { label, ...this.stringifyProps(metadata) },
      });
    } catch {
      this.fallbackNodes.set(id, { type: 'file', label, metadata });
    }
  }

  /** Add a concept node */
  async addConceptNode(id: string, label: string): Promise<void> {
    if (this.useFallback || !this.graph) {
      this.fallbackNodes.set(id, { type: 'concept', label, metadata: {} });
      return;
    }
    try {
      await this.graph.createNode({
        id,
        embedding: new Float32Array(this.dimensions),
        labels: ['concept'],
        properties: { label },
      });
    } catch {
      this.fallbackNodes.set(id, { type: 'concept', label, metadata: {} });
    }
  }

  /** Connect a file to a concept */
  async connectFileToConcept(fileId: string, conceptId: string, weight = 1.0): Promise<void> {
    const edge = { source: fileId, target: conceptId, type: 'contains', weight };
    if (this.useFallback || !this.graph) {
      this.fallbackEdges.push(edge);
      return;
    }
    try {
      await this.graph.createEdge({
        from: fileId,
        to: conceptId,
        description: 'contains',
        embedding: new Float32Array(this.dimensions),
        confidence: weight,
      });
    } catch {
      this.fallbackEdges.push(edge);
    }
  }

  /** Connect two files as similar */
  async connectSimilarFiles(fileId1: string, fileId2: string, similarity: number): Promise<void> {
    const edge = { source: fileId1, target: fileId2, type: 'similar_to', weight: similarity };
    if (this.useFallback || !this.graph) {
      this.fallbackEdges.push(edge);
      return;
    }
    try {
      await this.graph.createEdge({
        from: fileId1,
        to: fileId2,
        description: 'similar_to',
        embedding: new Float32Array(this.dimensions),
        confidence: similarity,
      });
    } catch {
      this.fallbackEdges.push(edge);
    }
  }

  /** Find files related to a given file through the graph */
  async getRelatedFiles(fileId: string, limit = 5): Promise<Array<{ id: string; label: string; weight: number }>> {
    if (this.useFallback || !this.graph) {
      return this.fallbackGetRelated(fileId, limit);
    }

    try {
      // Use k-hop neighbors for related files
      const neighbors = await this.graph.kHopNeighbors(fileId, 2);
      return neighbors.slice(0, limit).map(id => ({
        id,
        label: this.fallbackNodes.get(id)?.label ?? id,
        weight: 0.5,
      }));
    } catch {
      return this.fallbackGetRelated(fileId, limit);
    }
  }

  /** Remove a file node and its edges */
  async removeFileNode(fileId: string): Promise<void> {
    // For the native graph, there's no direct remove — just track in fallback
    this.fallbackNodes.delete(fileId);
    this.fallbackEdges = this.fallbackEdges.filter(
      e => e.source !== fileId && e.target !== fileId
    );
  }

  /** Get graph stats */
  async getStats(): Promise<{ nodes: number; edges: number }> {
    if (this.useFallback || !this.graph) {
      return { nodes: this.fallbackNodes.size, edges: this.fallbackEdges.length };
    }
    try {
      const stats: JsGraphStats = await this.graph.stats();
      return { nodes: stats.totalNodes, edges: stats.totalEdges };
    } catch {
      return { nodes: this.fallbackNodes.size, edges: this.fallbackEdges.length };
    }
  }

  /** Get all nodes for visualization */
  getNodesForVisualization(): Array<{ id: string; type: string; label: string }> {
    const nodes: Array<{ id: string; type: string; label: string }> = [];
    for (const [id, node] of this.fallbackNodes) {
      nodes.push({ id, type: node.type, label: node.label });
    }
    return nodes;
  }

  /** Get all edges for visualization */
  getEdgesForVisualization(): Array<{ source: string; target: string; type: string; weight: number }> {
    return [...this.fallbackEdges];
  }

  private fallbackGetRelated(fileId: string, limit: number): Array<{ id: string; label: string; weight: number }> {
    const connected = new Map<string, number>();

    for (const edge of this.fallbackEdges) {
      if (edge.source === fileId && edge.type === 'similar_to') {
        connected.set(edge.target, edge.weight);
      } else if (edge.target === fileId && edge.type === 'similar_to') {
        connected.set(edge.source, edge.weight);
      }
      // Two-hop: file -> concept -> file
      if (edge.source === fileId && edge.type === 'contains') {
        const conceptId = edge.target;
        for (const e2 of this.fallbackEdges) {
          if (e2.target === conceptId && e2.type === 'contains' && e2.source !== fileId) {
            const existing = connected.get(e2.source) ?? 0;
            connected.set(e2.source, Math.max(existing, edge.weight * e2.weight));
          }
        }
      }
    }

    return [...connected.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, weight]) => ({
        id,
        label: this.fallbackNodes.get(id)?.label ?? id,
        weight,
      }));
  }

  /** Convert metadata values to string record (graph-node requires string props) */
  private stringifyProps(metadata: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      result[k] = String(v);
    }
    return result;
  }
}
