# RuVector OS

**System-level intelligence layer for macOS** — semantic search that learns, runs 100% locally, and gives AI agents access to your entire file system knowledge.

RuVector OS is a background daemon that watches your files, builds semantic embeddings using ONNX (all-MiniLM-L6-v2), stores them in an HNSW vector index, constructs a knowledge graph of connections between your documents, and exposes everything through a CLI, web dashboard, and MCP server for Claude integration.

**Zero cloud dependency. Zero network access. Your data never leaves your machine.**

---

## Features

- **Semantic Search** — Find files by meaning, not just keywords. "That Rust async article" finds the exact blog post, not a random tutorial.
- **Knowledge Graph** — Discovers connections between files across projects and domains automatically.
- **Learns Over Time** — Search results improve as the system learns from your patterns (GNN layer, Tier 2).
- **100% Local** — ONNX embeddings run on-device. No API keys, no internet, no data exfiltration.
- **Sub-millisecond Search** — HNSW index via ruvector delivers results in <1ms for 50K+ files.
- **MCP Server** — Claude and other AI agents can query your indexed filesystem in natural language.
- **Web Dashboard** — Real-time search, knowledge graph visualization, and index stats at localhost:3333.
- **macOS LaunchAgent** — Runs as a background service, starts at login, restarts on crash.
- **Opt-in Everything** — Only watches directories you explicitly add. Read-only. No network.

---

## Quick Start

### 1. Install

```bash
git clone <repo-url> ruvector-os
cd ruvector-os
npm install
npm run build
```

### 2. Initialize

```bash
node dist/cli/cli.js init
```

This creates the data directory (`~/Library/Application Support/ruvector-os/`) and downloads the ONNX model (~22MB).

### 3. Start Indexing

```bash
node dist/cli/cli.js start --watch ~/Projects
```

The daemon will:
- Watch `~/Projects` for file changes (FSEvents, near-zero CPU)
- Extract text content from supported file types
- Compute 384-dimensional embeddings via ONNX
- Store vectors in the HNSW index
- Build a knowledge graph of file relationships
- Serve the dashboard at http://localhost:3333

### 4. Search

```bash
# Via CLI (queries the running daemon's API)
node dist/cli/cli.js search "authentication middleware"

# Via dashboard
open http://localhost:3333

# Via MCP (for Claude integration)
node dist/cli/cli.js mcp-server
```

### 5. Stop

```bash
node dist/cli/cli.js stop
```

---

## CLI Reference

```
ruvector-memory [command] [options]

Commands:
  init                          Create data directory, download ONNX model
  start [options]               Start the daemon
    --watch <dirs...>           Directories to watch
    --port <port>               Dashboard port (default: 3333)
    --foreground                Run in foreground (no LaunchAgent)
  stop                          Stop the daemon
  status                        Show daemon and index status
  search <query> [options]      Semantic search
    -l, --limit <n>             Max results (default: 10)
    -t, --threshold <n>         Min similarity 0-1 (default: 0.3)
    -d, --directory <dir>       Filter by directory
  watch add <dir>               Add a directory to watch
  watch remove <dir>            Remove a directory from watch
  watch list                    List watched directories
  mcp-server                    Start MCP server (stdio, for Claude)
  uninstall [options]           Uninstall completely
    --delete-data               Also delete all indexed data
```

---

## Dashboard

The web dashboard runs at `http://localhost:3333` and provides:

- **Search Bar** — Natural language search with ranked results
- **Index Stats** — Files indexed, vectors, graph nodes/edges, memory usage, uptime
- **Watched Directories** — See which directories are being monitored
- **Knowledge Graph** — Visual graph of file and concept connections
- **Activity Log** — Real-time stream of indexing events via WebSocket

---

## MCP Integration (Claude)

RuVector OS includes an MCP server that gives Claude (or any MCP-compatible AI) access to your indexed filesystem.

### Setup

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "ruvector-os": {
      "command": "node",
      "args": ["/path/to/ruvector-os/dist/cli/cli.js", "mcp-server"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Semantic search across indexed files |
| `related_files` | Find files related to a given file path |
| `index_status` | Get daemon status, index stats, memory usage |
| `file_info` | Get metadata for a specific indexed file |

### Example

Once connected, you can ask Claude:
- "Find the architecture document I wrote last month"
- "What files are related to the authentication system?"
- "How many files are indexed and what's the memory usage?"

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLI (commander)                                             │
│  ruvector-memory start / search / status / watch / ...       │
└───────┬─────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────────────┐
│  Daemon (daemon.ts)                                          │
│  Orchestrates all subsystems, handles lifecycle               │
│                                                               │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ FSWatcher │  │ OnnxEmbedder │  │ DashboardServer        │ │
│  │ chokidar  │  │ onnxruntime  │  │ Express + WebSocket    │ │
│  │ FSEvents  │  │ MiniLM-L6-v2 │  │ localhost:3333         │ │
│  └─────┬────┘  └──────┬───────┘  └────────────────────────┘ │
│        │               │                                      │
│  ┌─────▼───────────────▼──────────────────────────────────┐  │
│  │  Indexer (indexer.ts)                                    │  │
│  │  Batched pipeline: extract → embed → store → graph      │  │
│  └─────┬──────────────┬──────────────┬────────────────────┘  │
│        │              │              │                        │
│  ┌─────▼────┐  ┌──────▼─────┐  ┌───▼──────────────┐        │
│  │VectorStore│  │ MetadataDb │  │ KnowledgeGraph   │        │
│  │ ruvector  │  │  sql.js    │  │ @ruvector/       │        │
│  │ HNSW     │  │  SQLite    │  │ graph-node       │        │
│  └──────────┘  └────────────┘  └──────────────────┘        │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  SearchEngine (search.ts)                               │  │
│  │  Vector similarity + graph traversal + recency boost    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Server (@modelcontextprotocol/sdk)                 │  │
│  │  Tools: search, related_files, index_status, file_info  │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────────────┐
│  Storage: ~/Library/Application Support/ruvector-os/         │
│  ├── config.json          Configuration                      │
│  ├── ruvector.db          SQLite metadata (sql.js)           │
│  ├── vectors/index.db     HNSW vector index (ruvector)       │
│  ├── graph/knowledge.db   Knowledge graph                    │
│  ├── models/              ONNX model + tokenizer             │
│  ├── daemon.pid           Process ID file                    │
│  └── daemon.log           Log output                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Supported File Types

RuVector OS indexes text-based files with these extensions:

| Category | Extensions |
|----------|-----------|
| Documents | `.txt`, `.md`, `.markdown`, `.tex`, `.bib` |
| JavaScript/TypeScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| Java/JVM | `.java`, `.kt`, `.scala` |
| C/C++ | `.c`, `.cpp`, `.h`, `.hpp` |
| Ruby | `.rb` |
| PHP | `.php` |
| Swift | `.swift` |
| Web | `.html`, `.css`, `.scss`, `.less` |
| Data | `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`, `.tsv` |
| Shell | `.sh`, `.bash`, `.zsh`, `.fish` |
| Database | `.sql`, `.graphql`, `.prisma`, `.proto` |
| Config | `.env`, `.gitignore`, `.dockerignore` |
| Science | `.r`, `.R`, `.jl` |

Also indexes extensionless config files: `Makefile`, `Dockerfile`, `Rakefile`, `Gemfile`, `LICENSE`, `README`, `CHANGELOG`.

**Ignored directories:** `node_modules`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.cache`, `venv`, and more.

**Max file size:** 1MB (configurable).

---

## Configuration

Configuration is stored at `~/Library/Application Support/ruvector-os/config.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `watchDirs` | `[]` | Directories to watch |
| `dashboardPort` | `3333` | Web dashboard port |
| `dimensions` | `384` | Embedding dimensions |
| `maxElements` | `100000` | Max vectors in HNSW index |
| `indexExtensions` | (see above) | File extensions to index |
| `ignoreDirs` | (see above) | Directories to skip |
| `maxFileSize` | `1048576` | Max file size in bytes (1MB) |
| `modelIdleTimeout` | `300000` | Unload ONNX model after 5min idle |
| `clipboardEnabled` | `false` | Clipboard monitoring (Tier 3) |

---

## Resource Usage

Measured on Apple Silicon (M-series) with 17 source files:

| Metric | Value |
|--------|-------|
| RAM (steady state) | ~250MB |
| Initial index (17 files) | ~12 seconds |
| ONNX model size | 21.9MB |
| Search latency | <1ms (HNSW) + ~10ms (ONNX embed) |
| CPU (idle watching) | ~0% |
| CPU (during indexing) | ~20% single core |

### Projected Scale

| Files | Vector Index | RAM | Initial Index Time |
|-------|-------------|-----|-------------------|
| 10K | ~15MB | ~155MB | ~2 min |
| 50K | ~75MB | ~250MB | ~8 min |
| 100K | ~150MB | ~350MB | ~17 min |
| 200K | ~300MB | ~610MB | ~33 min |

---

## Data Safety

- **Read-only** — RuVector OS never writes, moves, renames, or deletes your files
- **No network** — Zero outbound connections (verifiable via Little Snitch / firewall)
- **Opt-in scope** — Only watches directories you explicitly add
- **Local storage** — All data in `~/Library/Application Support/ruvector-os/`
- **Easy uninstall** — `ruvector-memory uninstall --delete-data` removes everything

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Type check
npm run typecheck
```

### Project Structure

```
src/
├── cli/cli.ts              # CLI entry point (commander)
├── daemon/
│   ├── daemon.ts           # Main daemon orchestrator
│   ├── config.ts           # Config load/save
│   └── launchagent.ts      # macOS LaunchAgent management
├── watcher/
│   └── fs-watcher.ts       # File system watcher (chokidar/FSEvents)
├── embeddings/
│   └── onnx-embedder.ts    # ONNX embedding pipeline
├── engine/
│   ├── vector-store.ts     # HNSW vector index (ruvector)
│   ├── metadata-db.ts      # SQLite metadata (sql.js)
│   ├── knowledge-graph.ts  # Graph database (@ruvector/graph-node)
│   ├── indexer.ts           # Indexing pipeline
│   └── search.ts           # Unified search engine
├── mcp/
│   └── server.ts           # MCP server for Claude
├── dashboard/
│   └── server.ts           # Web dashboard (Express + WebSocket)
├── shared/
│   ├── types.ts            # TypeScript interfaces
│   ├── paths.ts            # File system paths
│   └── utils.ts            # Utilities
└── index.ts                # Library exports
```

---

## Roadmap

| Tier | Timeline | Features |
|------|----------|----------|
| **Tier 1** (current) | Week 1-2 | CLI, semantic search, knowledge graph, MCP server, dashboard |
| **Tier 2** | Week 3-4 | GNN learning from search patterns, cross-file connection discovery, importance weighting |
| **Tier 3** | Week 5-6 | Menu bar UI (Tauri), global hotkey, clipboard history, duplicate detection |
| **Tier 4** | Week 7+ | Temporal queries, Cypher graph queries, Phago integration, auto-tagging |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `ruvector` | HNSW vector database (native Rust via NAPI) |
| `@ruvector/graph-node` | Knowledge graph with Cypher queries |
| `@ruvector/gnn` | Graph neural network layer |
| `onnxruntime-node` | ONNX model inference |
| `chokidar` | File system watching (FSEvents on macOS) |
| `@modelcontextprotocol/sdk` | MCP server for AI integration |
| `commander` | CLI framework |
| `express` | Dashboard HTTP server |
| `ws` | WebSocket for real-time updates |
| `sql.js` | SQLite via WebAssembly (zero native deps) |
| `chalk` / `ora` | Terminal styling |

---

## License

MIT
