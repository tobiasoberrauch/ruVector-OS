import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DashboardServer } from './server.js';
import { EventEmitter } from 'events';

// Create a comprehensive mock daemon
function createMockDaemon() {
  const emitter = new EventEmitter();
  const daemon = Object.assign(emitter, {
    search: vi.fn().mockResolvedValue([
      {
        file: {
          id: 'f1',
          path: '/src/app.ts',
          name: 'app.ts',
          extension: '.ts',
          size: 100,
          modifiedAt: Date.now(),
          indexedAt: Date.now(),
          embeddedAt: Date.now(),
          contentPreview: 'const app = express();',
          contentHash: 'abc123',
        },
        score: 0.95,
        snippet: 'const app = express();',
        searchId: 1,
        tags: ['typescript'],
      },
    ]),
    getStatus: vi.fn().mockResolvedValue({
      running: true,
      pid: 12345,
      uptime: 60000,
      indexedFiles: 42,
      totalVectors: 42,
      graphNodes: 100,
      graphEdges: 50,
      watchedDirs: ['/tmp/test'],
      memoryUsage: { rss: 50 * 1024 * 1024, heapUsed: 30 * 1024 * 1024, heapTotal: 60 * 1024 * 1024 },
      storageSize: 1024 * 1024,
      lastActivity: Date.now(),
    }),
    getIndexerStats: vi.fn().mockReturnValue({
      indexed: 42,
      updated: 5,
      deleted: 2,
      queueLength: 0,
      avgEmbeddingTime: 15.5,
    }),
    getConfig: vi.fn().mockReturnValue({
      watchDirs: ['/tmp/test'],
      dashboardPort: 3333,
      maxFileSize: 1024 * 1024,
      indexExtensions: ['.ts', '.js'],
      ignoreDirs: ['node_modules'],
    }),
    updateConfig: vi.fn().mockResolvedValue({
      valid: true,
      errors: [],
      requiresRestart: [],
    }),
    getGraph: vi.fn().mockReturnValue({
      getNodesForVisualization: vi.fn().mockReturnValue([
        { id: 'f1', type: 'file', label: 'app.ts' },
      ]),
      getEdgesForVisualization: vi.fn().mockReturnValue([]),
      getRelatedFiles: vi.fn().mockResolvedValue([
        { id: 'f2', label: 'index.ts', weight: 0.85, edgeType: 'similar_to' },
      ]),
    }),
    getMetadataDb: vi.fn().mockReturnValue({
      getFile: vi.fn().mockReturnValue({
        id: 'f2',
        path: '/src/index.ts',
        name: 'index.ts',
        extension: '.ts',
        size: 200,
        modifiedAt: Date.now(),
        indexedAt: Date.now(),
        embeddedAt: Date.now(),
        contentPreview: 'import app from "./app";',
        contentHash: 'def456',
      }),
    }),
    addWatchDir: vi.fn().mockResolvedValue(undefined),
    removeWatchDir: vi.fn().mockResolvedValue(undefined),
    recordClick: vi.fn().mockResolvedValue(undefined),
    getLearningMetrics: vi.fn().mockReturnValue({
      totalSearches: 10,
      totalClicks: 5,
      clickThroughRate: 0.5,
      topFilesByImportance: [
        { fileId: 'f1', path: '/src/app.ts', score: 0.8 },
      ],
      lastSweepTime: Date.now(),
      sweepFileCount: 42,
      gnnActive: false,
    }),
    getSearchAnalytics: vi.fn().mockReturnValue({
      topQueries: [{ query: 'test', count: 5, lastUsed: Date.now() }],
      volumeByDay: [{ date: '2025-01-01', count: 3 }],
      clickStats: { totalSearches: 10, totalClicks: 5, ctr: 0.5 },
    }),
    getTags: vi.fn().mockReturnValue([
      { id: 't1', label: 'typescript', fileCount: 20 },
    ]),
    getFileTags: vi.fn().mockReturnValue([]),
    getDuplicates: vi.fn().mockReturnValue([
      {
        type: 'hash',
        files: [
          { id: 'f1', path: '/a.ts', name: 'a.ts' },
          { id: 'f2', path: '/b.ts', name: 'b.ts' },
        ],
      },
    ]),
    triggerAutoTag: vi.fn().mockResolvedValue({ tagsCreated: 3, filesTagged: 15 }),
  });
  return daemon;
}

describe('DashboardServer API', () => {
  let server: DashboardServer;
  let daemon: ReturnType<typeof createMockDaemon>;
  let baseUrl: string;
  const PORT = 13333; // Use high port to avoid conflicts

  beforeAll(async () => {
    daemon = createMockDaemon();
    server = new DashboardServer(daemon as any, PORT);
    await server.start();
    baseUrl = `http://127.0.0.1:${PORT}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET / returns dashboard HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RuVector OS');
    expect(html).toContain('Semantic Search');
  });

  it('POST /api/search returns results', async () => {
    const res = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test query', limit: 10 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].file.path).toBe('/src/app.ts');
    expect(daemon.search).toHaveBeenCalled();
  });

  it('GET /api/status returns status', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status.running).toBe(true);
    expect(data.status.indexedFiles).toBe(42);
    expect(data.indexerStats.indexed).toBe(42);
  });

  it('GET /api/config returns config', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.dashboardPort).toBe(3333);
    expect(data.watchDirs).toContain('/tmp/test');
  });

  it('PUT /api/config updates config', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxFileSize: 2 * 1024 * 1024 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(daemon.updateConfig).toHaveBeenCalledWith({ maxFileSize: 2 * 1024 * 1024 });
  });

  it('PUT /api/config returns 400 on invalid config', async () => {
    daemon.updateConfig.mockResolvedValueOnce({
      valid: false,
      errors: ['port out of range'],
      requiresRestart: [],
    });
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboardPort: 0 }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.errors).toContain('port out of range');
  });

  it('GET /api/graph returns graph data', async () => {
    const res = await fetch(`${baseUrl}/api/graph`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].label).toBe('app.ts');
  });

  it('POST /api/watch adds watch directory', async () => {
    const res = await fetch(`${baseUrl}/api/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: '/tmp/new-dir' }),
    });
    expect(res.status).toBe(200);
    expect(daemon.addWatchDir).toHaveBeenCalledWith('/tmp/new-dir');
  });

  it('DELETE /api/watch removes watch directory', async () => {
    const res = await fetch(`${baseUrl}/api/watch`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: '/tmp/test' }),
    });
    expect(res.status).toBe(200);
    expect(daemon.removeWatchDir).toHaveBeenCalledWith('/tmp/test');
  });

  it('POST /api/click records a click', async () => {
    const res = await fetch(`${baseUrl}/api/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchId: 1, fileId: 'f1', position: 0 }),
    });
    expect(res.status).toBe(200);
    expect(daemon.recordClick).toHaveBeenCalledWith(1, 'f1', 0);
  });

  it('POST /api/click rejects invalid payload', async () => {
    const res = await fetch(`${baseUrl}/api/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchId: 'bad', fileId: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/learning returns learning metrics', async () => {
    const res = await fetch(`${baseUrl}/api/learning`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.totalSearches).toBe(10);
    expect(data.clickThroughRate).toBe(0.5);
  });

  it('GET /api/analytics returns search analytics', async () => {
    const res = await fetch(`${baseUrl}/api/analytics`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.topQueries).toHaveLength(1);
    expect(data.topQueries[0].query).toBe('test');
  });

  it('GET /api/tags returns tags', async () => {
    const res = await fetch(`${baseUrl}/api/tags`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.tags).toHaveLength(1);
    expect(data.tags[0].label).toBe('typescript');
  });

  it('GET /api/duplicates returns duplicate groups', async () => {
    const res = await fetch(`${baseUrl}/api/duplicates`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].type).toBe('hash');
    expect(data.groups[0].files).toHaveLength(2);
  });

  it('GET /api/related/:fileId returns related files', async () => {
    const res = await fetch(`${baseUrl}/api/related/f1`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.related).toHaveLength(1);
    expect(data.related[0].edgeType).toBe('similar_to');
    expect(data.related[0].weight).toBe(0.85);
  });

  it('POST /api/autotag triggers auto-tagging', async () => {
    const res = await fetch(`${baseUrl}/api/autotag`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.tagsCreated).toBe(3);
    expect(data.filesTagged).toBe(15);
  });
});
