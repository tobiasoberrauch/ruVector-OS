import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import type { RuvectorDaemon } from '../daemon/daemon.js';

/**
 * Web dashboard at localhost:3333
 * Provides: search UI, knowledge graph visualization, index stats, real-time updates
 */
export class DashboardServer {
  private app = express();
  private httpServer = createServer(this.app);
  private wss: WebSocketServer;
  private daemon: RuvectorDaemon;
  private port: number;

  constructor(daemon: RuvectorDaemon, port = 3333) {
    this.daemon = daemon;
    this.port = port;
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // Serve dashboard HTML
    this.app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(this.getDashboardHTML());
    });

    // API: Search
    this.app.post('/api/search', async (req, res) => {
      try {
        const { query, limit = 10, threshold = 0.3 } = req.body;
        const results = await this.daemon.search({ query, limit, threshold });
        res.json({ results });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Status
    this.app.get('/api/status', async (_req, res) => {
      const status = await this.daemon.getStatus();
      const indexerStats = this.daemon.getIndexerStats();
      res.json({ status, indexerStats });
    });

    // API: Config
    this.app.get('/api/config', (_req, res) => {
      res.json(this.daemon.getConfig());
    });

    // API: Update config
    this.app.put('/api/config', async (req, res) => {
      try {
        const result = await this.daemon.updateConfig(req.body);
        if (!result.valid) {
          res.status(400).json({ errors: result.errors });
          return;
        }
        res.json({
          ok: true,
          requiresRestart: result.requiresRestart,
          config: this.daemon.getConfig(),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Graph data for visualization
    this.app.get('/api/graph', (_req, res) => {
      const graph = this.daemon.getGraph();
      const nodes = graph.getNodesForVisualization();
      const edges = graph.getEdgesForVisualization();
      res.json({ nodes, edges });
    });

    // API: Watch directory
    this.app.post('/api/watch', async (req, res) => {
      try {
        const { dir } = req.body;
        await this.daemon.addWatchDir(dir);
        res.json({ ok: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Unwatch directory
    this.app.delete('/api/watch', async (req, res) => {
      try {
        const { dir } = req.body;
        await this.daemon.removeWatchDir(dir);
        res.json({ ok: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Record a click on a search result (Tier 2 Learning)
    this.app.post('/api/click', async (req, res) => {
      try {
        const { searchId, fileId, position } = req.body;
        if (typeof searchId !== 'number' || !fileId) {
          res.status(400).json({ error: 'searchId (number) and fileId (string) required' });
          return;
        }
        await this.daemon.recordClick(searchId, fileId, position ?? 0);
        res.json({ ok: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Learning metrics (Tier 2 Learning)
    this.app.get('/api/learning', (_req, res) => {
      try {
        const metrics = this.daemon.getLearningMetrics();
        res.json(metrics);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Search analytics (Tier 3)
    this.app.get('/api/analytics', (_req, res) => {
      try {
        const analytics = this.daemon.getSearchAnalytics();
        res.json(analytics);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Tags (Tier 3)
    this.app.get('/api/tags', (_req, res) => {
      try {
        const tags = this.daemon.getTags();
        res.json({ tags });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Related files
    this.app.get('/api/related/:fileId', async (req, res) => {
      try {
        const { fileId } = req.params;
        const limit = parseInt(req.query.limit as string) || 10;
        const graph = this.daemon.getGraph();
        const db = this.daemon.getMetadataDb();
        const related = await graph.getRelatedFiles(fileId, limit);

        const results = related.map(r => {
          const file = db.getFile(r.id);
          return {
            id: r.id,
            path: file?.path ?? r.label,
            name: file?.name ?? r.label,
            weight: r.weight,
            edgeType: r.edgeType,
          };
        });

        res.json({ related: results });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Duplicates
    this.app.get('/api/duplicates', (_req, res) => {
      try {
        const groups = this.daemon.getDuplicates();
        res.json({ groups });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Trigger auto-tagging (Tier 3)
    this.app.post('/api/autotag', async (_req, res) => {
      try {
        const result = await this.daemon.triggerAutoTag();
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', async (ws) => {
      // Send initial status
      const status = await this.daemon.getStatus();
      ws.send(JSON.stringify({ type: 'status', data: status }));
    });

    // Forward daemon events to all connected clients
    this.daemon.on('indexed', (file) => {
      this.broadcast({ type: 'indexed', data: { path: file.path, name: file.name } });
    });
    this.daemon.on('updated', (file) => {
      this.broadcast({ type: 'updated', data: { path: file.path, name: file.name } });
    });
    this.daemon.on('deleted', (path) => {
      this.broadcast({ type: 'deleted', data: { path } });
    });
    this.daemon.on('log', (msg) => {
      this.broadcast({ type: 'log', data: { message: msg } });
    });

    // Periodic status updates
    setInterval(async () => {
      const status = await this.daemon.getStatus();
      this.broadcast({ type: 'status', data: status });
    }, 5000);
  }

  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** Start listening */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  /** Stop the server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close();
      this.httpServer.close(() => resolve());
    });
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RuVector OS — Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-dim: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --orange: #d29922;
      --red: #f85149;
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
    }
    .header .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .full-width { grid-column: 1 / -1; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }
    .card h2 {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin-bottom: 16px;
    }
    .search-box {
      display: flex;
      gap: 8px;
    }
    .search-box input {
      flex: 1;
      padding: 10px 16px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-size: 15px;
      outline: none;
    }
    .search-box input:focus { border-color: var(--accent); }
    .search-box button {
      padding: 10px 20px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      font-weight: 600;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
    }
    .stat {
      text-align: center;
    }
    .stat .value {
      font-size: 28px;
      font-weight: 700;
      color: var(--accent);
    }
    .stat .label {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 4px;
    }
    .results {
      max-height: 400px;
      overflow-y: auto;
    }
    .result-item {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .result-item:hover { background: rgba(88, 166, 255, 0.05); }
    .result-item .path {
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 13px;
      color: var(--accent);
    }
    .result-item .score {
      font-size: 12px;
      color: var(--green);
      float: right;
    }
    .result-item .preview {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .related-panel {
      margin-top: 6px;
      padding: 8px 12px;
      background: var(--bg);
      border-radius: 4px;
      font-size: 12px;
    }
    .related-panel .related-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
    }
    .edge-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
    }
    .edge-badge.similar_to { background: rgba(88,166,255,0.15); color: var(--accent); }
    .edge-badge.duplicate_of { background: rgba(248,81,73,0.15); color: var(--red); }
    .edge-badge.co_accessed { background: rgba(210,153,34,0.15); color: var(--orange); }
    .edge-badge.concept { background: rgba(63,185,80,0.15); color: var(--green); }
    .dir-list {
      list-style: none;
    }
    .dir-list li {
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dir-list li::before {
      content: '📁';
    }
    .log-output {
      max-height: 200px;
      overflow-y: auto;
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: var(--text-dim);
      line-height: 1.6;
    }
    #graph-canvas {
      width: 100%;
      height: 400px;
      background: var(--bg);
      border-radius: var(--radius);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="status-dot" id="statusDot"></div>
    <h1>RuVector OS</h1>
    <span id="statusText" style="color: var(--text-dim); font-size: 13px;">Connecting...</span>
  </div>

  <div class="container">
    <!-- Search -->
    <div class="card full-width">
      <h2>Semantic Search</h2>
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="Search your files with natural language..." autocomplete="off">
        <button onclick="doSearch()">Search</button>
      </div>
      <div class="results" id="results"></div>
    </div>

    <!-- Stats -->
    <div class="card">
      <h2>Index Stats</h2>
      <div class="stat-grid">
        <div class="stat">
          <div class="value" id="statFiles">0</div>
          <div class="label">Files Indexed</div>
        </div>
        <div class="stat">
          <div class="value" id="statVectors">0</div>
          <div class="label">Vectors</div>
        </div>
        <div class="stat">
          <div class="value" id="statNodes">0</div>
          <div class="label">Graph Nodes</div>
        </div>
        <div class="stat">
          <div class="value" id="statEdges">0</div>
          <div class="label">Graph Edges</div>
        </div>
        <div class="stat">
          <div class="value" id="statMemory">0</div>
          <div class="label">Memory (MB)</div>
        </div>
        <div class="stat">
          <div class="value" id="statUptime">0s</div>
          <div class="label">Uptime</div>
        </div>
      </div>
    </div>

    <!-- Watched Dirs -->
    <div class="card">
      <h2>Watched Directories</h2>
      <ul class="dir-list" id="dirList"></ul>
    </div>

    <!-- Learning (Tier 2) -->
    <div class="card full-width">
      <h2>Learning</h2>
      <div class="stat-grid" id="learningStats">
        <div class="stat">
          <div class="value" id="learnSearches">0</div>
          <div class="label">Total Searches</div>
        </div>
        <div class="stat">
          <div class="value" id="learnClicks">0</div>
          <div class="label">Total Clicks</div>
        </div>
        <div class="stat">
          <div class="value" id="learnCTR">0%</div>
          <div class="label">Click-Through Rate</div>
        </div>
        <div class="stat">
          <div class="value" id="learnGNN">-</div>
          <div class="label">GNN Active</div>
        </div>
        <div class="stat">
          <div class="value" id="learnSweep">-</div>
          <div class="label">Last Sweep</div>
        </div>
      </div>
      <div id="topFiles" style="margin-top:12px;font-size:13px;color:var(--text-dim)"></div>
    </div>

    <!-- Search Analytics (Tier 3) -->
    <div class="card">
      <h2>Search Analytics</h2>
      <div id="analyticsContent" style="font-size:13px;color:var(--text-dim)">Loading...</div>
    </div>

    <!-- Tags (Tier 3) -->
    <div class="card">
      <h2>Topic Tags</h2>
      <div id="tagsContent" style="font-size:13px;color:var(--text-dim)">Loading...</div>
    </div>

    <!-- Knowledge Graph -->
    <div class="card full-width">
      <h2>Knowledge Graph</h2>
      <canvas id="graph-canvas"></canvas>
    </div>

    <!-- Activity Log -->
    <div class="card full-width">
      <h2>Activity Log</h2>
      <div class="log-output" id="logOutput"></div>
    </div>
  </div>

  <script>
    let ws;
    const maxLogs = 100;
    const logs = [];

    // XSS prevention: escape HTML entities in dynamic content
    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function connect() {
      ws = new WebSocket('ws://' + location.host);
      ws.onopen = () => {
        document.getElementById('statusText').textContent = 'Connected';
        document.getElementById('statusDot').style.background = 'var(--green)';
      };
      ws.onclose = () => {
        document.getElementById('statusText').textContent = 'Disconnected — reconnecting...';
        document.getElementById('statusDot').style.background = 'var(--red)';
        setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      };
    }

    function handleMessage(msg) {
      if (msg.type === 'status') {
        const s = msg.data;
        document.getElementById('statFiles').textContent = s.indexedFiles;
        document.getElementById('statVectors').textContent = s.totalVectors;
        document.getElementById('statNodes').textContent = s.graphNodes;
        document.getElementById('statEdges').textContent = s.graphEdges;
        document.getElementById('statMemory').textContent = (s.memoryUsage.rss / 1024 / 1024).toFixed(0);
        document.getElementById('statUptime').textContent = formatUptime(s.uptime);

        const dirList = document.getElementById('dirList');
        dirList.innerHTML = s.watchedDirs.map(d => '<li>' + esc(d) + '</li>').join('');
      }
      if (msg.type === 'indexed' || msg.type === 'updated' || msg.type === 'deleted') {
        addLog(msg.type + ': ' + (msg.data.path || msg.data.name));
      }
      if (msg.type === 'log') {
        addLog(msg.data.message);
      }
    }

    function addLog(text) {
      logs.unshift(new Date().toLocaleTimeString() + ' ' + text);
      if (logs.length > maxLogs) logs.pop();
      document.getElementById('logOutput').innerHTML = logs.map(l => '<div>' + esc(l) + '</div>').join('');
    }

    async function doSearch() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 20 }),
      });
      const data = await res.json();
      const el = document.getElementById('results');

      if (!data.results || data.results.length === 0) {
        el.innerHTML = '<div style="padding:16px;color:var(--text-dim)">No results found.</div>';
        return;
      }

      el.innerHTML = data.results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        const preview = (r.file.contentPreview || '').slice(0, 150);
        const searchId = r.searchId || 0;
        const fileId = r.file.id || '';
        const tags = (r.tags || []).map(t => '<span style="background:rgba(88,166,255,0.15);color:var(--accent);padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px">' + esc(t) + '</span>').join('');
        return '<div class="result-item" onclick="trackClick(' + searchId + ',\\'' + esc(fileId) + '\\',' + i + ')">' +
          '<span class="score">' + esc(score) + '%</span>' +
          '<div class="path">' + esc(r.file.path) + '</div>' +
          (tags ? '<div style="margin-top:4px">' + tags + '</div>' : '') +
          '<div class="preview">' + esc(preview) + '</div>' +
          '<button onclick="event.stopPropagation();toggleRelated(\\'' + esc(fileId) + '\\',' + i + ')" style="margin-top:4px;background:none;border:1px solid var(--border);color:var(--text-dim);padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer">Related files</button>' +
          '<div id="related-' + i + '" class="related-panel" style="display:none"></div>' +
        '</div>';
      }).join('');
    }

    function formatUptime(ms) {
      if (ms < 60000) return Math.floor(ms / 1000) + 's';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
      return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
    }

    // Enter key to search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Simple graph visualization on canvas
    async function drawGraph() {
      const res = await fetch('/api/graph');
      const { nodes, edges } = await res.json();
      if (!nodes.length) return;

      const canvas = document.getElementById('graph-canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth * 2;
      canvas.height = canvas.offsetHeight * 2;
      ctx.scale(2, 2);
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      // Simple force-directed layout (single iteration for static view)
      const positions = new Map();
      nodes.forEach((n, i) => {
        const angle = (i / nodes.length) * Math.PI * 2;
        const r = Math.min(w, h) * 0.35;
        positions.set(n.id, {
          x: w / 2 + r * Math.cos(angle),
          y: h / 2 + r * Math.sin(angle),
        });
      });

      // Draw edges
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.15)';
      ctx.lineWidth = 0.5;
      for (const edge of edges) {
        const s = positions.get(edge.source);
        const t = positions.get(edge.target);
        if (s && t) {
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.stroke();
        }
      }

      // Draw nodes
      for (const node of nodes) {
        const pos = positions.get(node.id);
        if (!pos) continue;
        ctx.fillStyle = node.type === 'file' ? '#58a6ff' : '#3fb950';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, node.type === 'file' ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();

        // Label for files
        if (node.type === 'file') {
          ctx.fillStyle = 'rgba(230, 237, 243, 0.6)';
          ctx.font = '9px -apple-system, sans-serif';
          ctx.fillText(node.label, pos.x + 6, pos.y + 3);
        }
      }
    }

    async function toggleRelated(fileId, index) {
      const panel = document.getElementById('related-' + index);
      if (!panel) return;
      if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      panel.innerHTML = '<span style="color:var(--text-dim)">Loading...</span>';
      try {
        const res = await fetch('/api/related/' + encodeURIComponent(fileId));
        const data = await res.json();
        if (!data.related || data.related.length === 0) {
          panel.innerHTML = '<span style="color:var(--text-dim)">No related files found.</span>';
          return;
        }
        panel.innerHTML = data.related.map(function(r) {
          const pct = (r.weight * 100).toFixed(0);
          return '<div class="related-item">' +
            '<span class="edge-badge ' + esc(r.edgeType) + '">' + esc(r.edgeType) + '</span>' +
            '<span style="color:var(--accent);font-family:monospace;font-size:12px">' + esc(r.path) + '</span>' +
            '<span style="color:var(--text-dim)">' + esc(pct) + '%</span>' +
          '</div>';
        }).join('');
      } catch (e) {
        panel.innerHTML = '<span style="color:var(--red)">Error loading related files.</span>';
      }
    }

    async function trackClick(searchId, fileId, position) {
      try {
        await fetch('/api/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ searchId, fileId, position }),
        });
        addLog('Click recorded: ' + fileId);
        fetchLearning();
      } catch (e) {
        // best effort
      }
    }

    async function fetchLearning() {
      try {
        const res = await fetch('/api/learning');
        const m = await res.json();
        document.getElementById('learnSearches').textContent = m.totalSearches;
        document.getElementById('learnClicks').textContent = m.totalClicks;
        document.getElementById('learnCTR').textContent = (m.clickThroughRate * 100).toFixed(1) + '%';
        document.getElementById('learnGNN').textContent = m.gnnActive ? 'Yes' : 'No';
        document.getElementById('learnSweep').textContent = m.lastSweepTime ? new Date(m.lastSweepTime).toLocaleTimeString() : 'Never';
        const topEl = document.getElementById('topFiles');
        if (m.topFilesByImportance && m.topFilesByImportance.length > 0) {
          topEl.innerHTML = '<strong>Top files by importance:</strong><br>' +
            m.topFilesByImportance.map(f =>
              '<span style="color:var(--accent)">' + esc(f.path.split('/').pop()) + '</span> ' +
              '<span style="color:var(--green)">' + esc(f.score.toFixed(3)) + '</span>'
            ).join('<br>');
        } else {
          topEl.innerHTML = '<span style="color:var(--text-dim)">No learning data yet. Search and click results to start learning.</span>';
        }
      } catch (e) {
        // dashboard not ready yet
      }
    }

    async function fetchAnalytics() {
      try {
        const res = await fetch('/api/analytics');
        const a = await res.json();
        const el = document.getElementById('analyticsContent');
        let html = '';
        if (a.topQueries && a.topQueries.length > 0) {
          html += '<strong>Top queries:</strong><br>';
          html += a.topQueries.slice(0, 5).map(q =>
            '<span style="color:var(--accent)">' + esc(q.query) + '</span> <span style="color:var(--text-dim)">(' + esc(q.count) + 'x)</span>'
          ).join('<br>');
        }
        if (a.volumeByDay && a.volumeByDay.length > 0) {
          html += '<br><br><strong>Search volume (last 14d):</strong><br>';
          const maxCount = Math.max(...a.volumeByDay.map(d => d.count), 1);
          html += a.volumeByDay.map(d => {
            const barWidth = Math.max(2, (d.count / maxCount) * 100);
            return '<div style="display:flex;align-items:center;gap:6px;margin:2px 0">' +
              '<span style="width:70px;font-size:11px">' + d.date.slice(5) + '</span>' +
              '<div style="height:8px;background:var(--accent);border-radius:2px;width:' + barWidth + '%"></div>' +
              '<span style="font-size:11px;color:var(--text-dim)">' + d.count + '</span></div>';
          }).join('');
        }
        if (!html) html = 'No search data yet.';
        el.innerHTML = html;
      } catch (e) {
        // not ready
      }
    }

    async function fetchTags() {
      try {
        const res = await fetch('/api/tags');
        const data = await res.json();
        const el = document.getElementById('tagsContent');
        if (data.tags && data.tags.length > 0) {
          el.innerHTML = data.tags.map(t =>
            '<span style="display:inline-block;background:rgba(63,185,80,0.15);color:var(--green);padding:3px 10px;border-radius:4px;margin:3px 4px;font-size:12px">' +
            esc(t.label) + ' <span style="color:var(--text-dim)">(' + esc(t.fileCount) + ')</span></span>'
          ).join('');
        } else {
          el.innerHTML = 'No tags yet. Tags are auto-assigned when auto-tagging runs.';
        }
      } catch (e) {
        // not ready
      }
    }

    connect();
    setTimeout(drawGraph, 2000);
    setInterval(drawGraph, 30000);
    setTimeout(fetchLearning, 1000);
    setInterval(fetchLearning, 10000);
    setTimeout(fetchAnalytics, 1500);
    setInterval(fetchAnalytics, 15000);
    setTimeout(fetchTags, 2000);
    setInterval(fetchTags, 30000);
  </script>
</body>
</html>`;
  }
}
