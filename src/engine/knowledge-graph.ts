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

  /** Whether the graph is open and ready for operations */
  isOpen(): boolean {
    return this.graph !== null || this.useFallback;
  }

  /** Close the knowledge graph, releasing resources */
  close(): void {
    this.graph = null;
    this.fallbackNodes.clear();
    this.fallbackEdges = [];
  }

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

  /** Connect two files as duplicates (near-identical content) */
  async connectDuplicateFiles(fileId1: string, fileId2: string, similarity: number): Promise<void> {
    const edge = { source: fileId1, target: fileId2, type: 'duplicate_of', weight: similarity };
    if (this.useFallback || !this.graph) {
      this.fallbackEdges.push(edge);
      return;
    }
    try {
      await this.graph.createEdge({
        from: fileId1,
        to: fileId2,
        description: 'duplicate_of',
        embedding: new Float32Array(this.dimensions),
        confidence: similarity,
      });
    } catch {
      this.fallbackEdges.push(edge);
    }
  }

  /** Get duplicate file groups via connected components of duplicate_of edges */
  getDuplicateGroups(): Array<Array<{ id: string; label: string }>> {
    // Build adjacency list from duplicate_of edges
    const adj = new Map<string, Set<string>>();
    for (const edge of this.fallbackEdges) {
      if (edge.type !== 'duplicate_of') continue;
      if (!adj.has(edge.source)) adj.set(edge.source, new Set());
      if (!adj.has(edge.target)) adj.set(edge.target, new Set());
      adj.get(edge.source)!.add(edge.target);
      adj.get(edge.target)!.add(edge.source);
    }

    // Find connected components via BFS
    const visited = new Set<string>();
    const groups: Array<Array<{ id: string; label: string }>> = [];

    for (const nodeId of adj.keys()) {
      if (visited.has(nodeId)) continue;
      const component: Array<{ id: string; label: string }> = [];
      const queue = [nodeId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push({
          id: current,
          label: this.fallbackNodes.get(current)?.label ?? current,
        });
        for (const neighbor of adj.get(current) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      if (component.length > 1) {
        groups.push(component);
      }
    }

    return groups;
  }

  /** Find files related to a given file through the graph */
  async getRelatedFiles(fileId: string, limit = 5): Promise<Array<{ id: string; label: string; weight: number; edgeType: string }>> {
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
        edgeType: 'similar_to',
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

  private fallbackGetRelated(fileId: string, limit: number): Array<{ id: string; label: string; weight: number; edgeType: string }> {
    const connected = new Map<string, { weight: number; edgeType: string }>();

    const DIRECT_EDGE_TYPES = ['similar_to', 'co_accessed', 'duplicate_of'];

    for (const edge of this.fallbackEdges) {
      // Direct edges: similar_to, co_accessed, duplicate_of
      if (DIRECT_EDGE_TYPES.includes(edge.type)) {
        if (edge.source === fileId) {
          const existing = connected.get(edge.target);
          if (!existing || existing.weight < edge.weight) {
            connected.set(edge.target, { weight: edge.weight, edgeType: edge.type });
          }
        } else if (edge.target === fileId) {
          const existing = connected.get(edge.source);
          if (!existing || existing.weight < edge.weight) {
            connected.set(edge.source, { weight: edge.weight, edgeType: edge.type });
          }
        }
      }
      // Two-hop: file -> concept -> file
      if (edge.source === fileId && edge.type === 'contains') {
        const conceptId = edge.target;
        for (const e2 of this.fallbackEdges) {
          if (e2.target === conceptId && e2.type === 'contains' && e2.source !== fileId) {
            const transitiveWeight = edge.weight * e2.weight;
            const existing = connected.get(e2.source);
            if (!existing || existing.weight < transitiveWeight) {
              connected.set(e2.source, { weight: transitiveWeight, edgeType: 'concept' });
            }
          }
        }
      }
    }

    return [...connected.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, limit)
      .map(([id, { weight, edgeType }]) => ({
        id,
        label: this.fallbackNodes.get(id)?.label ?? id,
        weight,
        edgeType,
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
