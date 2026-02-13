import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @ruvector/graph-node to force fallback mode
vi.mock('@ruvector/graph-node', () => ({
  GraphDatabase: vi.fn().mockImplementation(() => {
    throw new Error('Native bindings not available');
  }),
}));

describe('KnowledgeGraph — fallback mode', () => {
  let KnowledgeGraph: typeof import('./knowledge-graph.js').KnowledgeGraph;
  let graph: InstanceType<typeof KnowledgeGraph>;

  beforeEach(async () => {
    const mod = await import('./knowledge-graph.js');
    KnowledgeGraph = mod.KnowledgeGraph;
    graph = new KnowledgeGraph();
    await graph.init();
  });

  it('initializes in fallback mode when native bindings fail', () => {
    expect(graph.isOpen()).toBe(true);
  });

  it('adds file nodes', async () => {
    await graph.addFileNode('f1', 'file1.ts', { path: '/src/file1.ts' });
    const stats = await graph.getStats();
    expect(stats.nodes).toBe(1);
  });

  it('adds concept nodes', async () => {
    await graph.addConceptNode('c1', 'typescript');
    const stats = await graph.getStats();
    expect(stats.nodes).toBe(1);
  });

  it('connects file to concept', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addConceptNode('c1', 'typescript');
    await graph.connectFileToConcept('f1', 'c1', 0.8);
    const stats = await graph.getStats();
    expect(stats.edges).toBe(1);
  });

  it('connects similar files', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.connectSimilarFiles('f1', 'f2', 0.9);
    const stats = await graph.getStats();
    expect(stats.edges).toBe(1);
  });

  it('finds related files via 2-hop traversal', async () => {
    // f1 → concept → f2 (2-hop)
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.addConceptNode('c1', 'shared-concept');
    await graph.connectFileToConcept('f1', 'c1', 0.8);
    await graph.connectFileToConcept('f2', 'c1', 0.7);

    const related = await graph.getRelatedFiles('f1', 5);
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe('f2');
    // Weight should be product of edge weights: 0.8 * 0.7 = 0.56
    expect(related[0].weight).toBeCloseTo(0.56, 1);
    expect(related[0].edgeType).toBe('concept');
  });

  it('finds directly similar files', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.connectSimilarFiles('f1', 'f2', 0.95);

    const related = await graph.getRelatedFiles('f1', 5);
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe('f2');
    expect(related[0].weight).toBe(0.95);
    expect(related[0].edgeType).toBe('similar_to');
  });

  it('prioritizes direct similarity over 2-hop', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.addConceptNode('c1', 'shared');
    await graph.connectFileToConcept('f1', 'c1', 0.5);
    await graph.connectFileToConcept('f2', 'c1', 0.5);
    await graph.connectSimilarFiles('f1', 'f2', 0.95);

    const related = await graph.getRelatedFiles('f1', 5);
    expect(related).toHaveLength(1);
    // Should use the higher similarity (0.95), not the 2-hop (0.25)
    expect(related[0].weight).toBe(0.95);
    expect(related[0].edgeType).toBe('similar_to');
  });

  it('removes file node and its edges', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.connectSimilarFiles('f1', 'f2', 0.9);

    await graph.removeFileNode('f1');
    const stats = await graph.getStats();
    expect(stats.nodes).toBe(1); // Only f2 left
    expect(stats.edges).toBe(0);
  });

  it('limits related files to requested count', async () => {
    await graph.addFileNode('f1', 'main.ts');
    for (let i = 2; i <= 10; i++) {
      await graph.addFileNode(`f${i}`, `file${i}.ts`);
      await graph.connectSimilarFiles('f1', `f${i}`, 1 - i * 0.05);
    }

    const related = await graph.getRelatedFiles('f1', 3);
    expect(related).toHaveLength(3);
    // Should be sorted by weight descending
    expect(related[0].weight).toBeGreaterThan(related[1].weight);
  });

  it('returns empty for non-existent file', async () => {
    const related = await graph.getRelatedFiles('nonexistent', 5);
    expect(related).toHaveLength(0);
  });

  it('gets nodes for visualization', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addConceptNode('c1', 'typescript');
    const nodes = graph.getNodesForVisualization();
    expect(nodes).toHaveLength(2);
    expect(nodes.find(n => n.type === 'file')).toBeTruthy();
    expect(nodes.find(n => n.type === 'concept')).toBeTruthy();
  });

  it('gets edges for visualization', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addConceptNode('c1', 'typescript');
    await graph.connectFileToConcept('f1', 'c1');
    const edges = graph.getEdgesForVisualization();
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe('contains');
  });

  it('returns edgeType duplicate_of for duplicate files', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addFileNode('f2', 'file2.ts');
    await graph.connectDuplicateFiles('f1', 'f2', 0.98);

    const related = await graph.getRelatedFiles('f1', 5);
    expect(related).toHaveLength(1);
    expect(related[0].edgeType).toBe('duplicate_of');
    expect(related[0].weight).toBe(0.98);
  });

  it('close clears all data', async () => {
    await graph.addFileNode('f1', 'file1.ts');
    await graph.addConceptNode('c1', 'typescript');
    await graph.connectFileToConcept('f1', 'c1');

    graph.close();

    const stats = await graph.getStats();
    expect(stats.nodes).toBe(0);
    expect(stats.edges).toBe(0);
  });
});
