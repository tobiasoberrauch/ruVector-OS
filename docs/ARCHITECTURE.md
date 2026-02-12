# RuVector OS — Architecture Documentation

---

## System Overview

RuVector OS is a Node.js daemon that runs as a macOS LaunchAgent. It uses native Rust libraries (via NAPI) for performance-critical operations (vector search, graph queries) and WebAssembly for portable operations (SQLite metadata).

```
┌──────────────────────────────────────────────────────────────────┐
│  macOS User Space                                                 │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  RuVector OS Daemon (Node.js, LaunchAgent)                  │  │
│  │                                                              │  │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │  │
│  │  │ CLI      │  │ Dashboard    │  │ MCP Server           │  │  │
│  │  │ commander│  │ Express+WS   │  │ @modelcontextprotocol│  │  │
│  │  └────┬─────┘  └──────┬───────┘  └──────────┬───────────┘  │  │
│  │       │                │                      │              │  │
│  │  ┌────▼────────────────▼──────────────────────▼───────────┐ │  │
│  │  │              RuvectorDaemon (Orchestrator)               │ │  │
│  │  │                                                          │ │  │
│  │  │  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │ │  │
│  │  │  │ FSWatcher  │ │ Indexer  │ │ Search   │ │ Config   │ │ │  │
│  │  │  │ (chokidar) │ │ (batch)  │ │ Engine   │ │ Manager  │ │ │  │
│  │  │  └─────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘ │ │  │
│  │  │        │             │            │                      │ │  │
│  │  │  ┌─────▼─────────────▼────────────▼─────────────────┐   │ │  │
│  │  │  │               Storage Layer                       │   │ │  │
│  │  │  │                                                    │   │ │  │
│  │  │  │  ┌──────────┐  ┌───────────┐  ┌───────────────┐  │   │ │  │
│  │  │  │  │VectorStore│  │MetadataDb │  │KnowledgeGraph │  │   │ │  │
│  │  │  │  │ ruvector  │  │  sql.js   │  │ graph-node    │  │   │ │  │
│  │  │  │  │ Rust NAPI │  │  WASM     │  │ Rust NAPI     │  │   │ │  │
│  │  │  │  └──────────┘  └───────────┘  └───────────────┘  │   │ │  │
│  │  │  └───────────────────────────────────────────────────┘   │ │  │
│  │  │                                                          │ │  │
│  │  │  ┌───────────────────────────────────────────────────┐   │ │  │
│  │  │  │  OnnxEmbedder (onnxruntime-node)                  │   │ │  │
│  │  │  │  all-MiniLM-L6-v2 | 384 dimensions | lazy load   │   │ │  │
│  │  │  └───────────────────────────────────────────────────┘   │ │  │
│  │  └──────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ~/Library/Application Support/ruvector-os/                    │  │
│  │  ├── config.json       ├── vectors/index.db                    │  │
│  │  ├── ruvector.db       ├── graph/knowledge.db                  │  │
│  │  ├── models/           ├── daemon.pid                          │  │
│  │  └── daemon.log                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. FSWatcher (`src/watcher/fs-watcher.ts`)

**Purpose:** Monitor directories for file changes using macOS native FSEvents.

**Implementation:**
- Uses `chokidar` v4 which leverages FSEvents on macOS (near-zero CPU)
- Emits `file-event` with type (`add`, `change`, `unlink`), path, and stats
- Filters files by extension whitelist and directory blacklist
- Skips files over the configurable size limit (default 1MB)
- Supports dynamic add/remove of watch directories at runtime

**Key Design Decisions:**
- `ignoreInitial: false` — processes existing files on first watch (initial indexing)
- `awaitWriteFinish` — waits for file writes to stabilize before processing
- `usePolling: false` — relies on native FSEvents (no polling overhead)

```
File System Event → chokidar → extension filter → size filter → emit 'file-event'
```

---

### 2. OnnxEmbedder (`src/embeddings/onnx-embedder.ts`)

**Purpose:** Convert text content into 384-dimensional semantic vectors using a local ONNX model.

**Model:** all-MiniLM-L6-v2 (quantized), 21.9MB
- Sentence transformer trained on 1B+ text pairs
- 384-dimensional output (good balance of quality vs. size)
- ~10ms per embedding on Apple Silicon

**Implementation:**
- **Lazy loading:** Model loaded on first `embed()` call, not at startup
- **Idle unloading:** After 5 minutes without use, model is freed from memory (~80MB savings)
- **Auto-download:** First `init` downloads from HuggingFace
- **WordPiece tokenization:** Simple implementation that covers 95%+ of cases
- **Mean pooling + L2 normalization:** Standard sentence embedding post-processing

**Lifecycle:**
```
Created (no memory) → First embed() → Load model (~80MB) → Process queries
                                                                   │
                                                          5 min idle
                                                                   │
                                                           Unload model
```

---

### 3. VectorStore (`src/engine/vector-store.ts`)

**Purpose:** Store and search 384-dimensional vectors using HNSW (Hierarchical Navigable Small World) graph.

**Implementation:**
- Uses `ruvector` npm package (Rust NAPI bindings)
- Constructor: `dimensions: 384`, `distanceMetric: 'Cosine'`, `hnswConfig: { m: 16, efConstruction: 200 }`
- All methods are async (Promise-based)
- Persistent storage at `~/Library/Application Support/ruvector-os/vectors/index.db`
- **File lock:** Only one process can open the database at a time

**API:**
```typescript
await vectorStore.upsert(id, vector, metadata)  // Insert or replace
await vectorStore.search(vector, k, threshold)   // Find k nearest
await vectorStore.get(id)                         // Get by ID
await vectorStore.delete(id)                      // Remove
await vectorStore.count()                         // Total vectors
```

**Performance:**
| Operation | Latency |
|-----------|---------|
| Insert | ~0.02ms |
| Search (k=10, 50K vectors) | <1ms |
| Delete | ~0.01ms |

---

### 4. MetadataDb (`src/engine/metadata-db.ts`)

**Purpose:** Store file metadata, search history, and concept mappings in SQLite.

**Implementation:**
- Uses `sql.js` (SQLite compiled to WebAssembly — zero native dependencies)
- Debounced persistence: writes to disk every 1 second (not on every change)
- Graceful close: final sync on shutdown

**Schema:**
```sql
files          -- id, path, name, extension, size, modified_at, indexed_at,
               -- embedded_at, content_preview, content_hash

search_history -- id, query, result_ids, clicked_id, timestamp

concepts       -- id, label, file_count, created_at, updated_at

file_concepts  -- file_id, concept_id, weight

stats          -- key, value, updated_at
```

**Why sql.js instead of better-sqlite3:**
`better-sqlite3` requires native compilation (node-gyp + Python). On Node.js 24 with Python 3.14, the `distutils` module is removed, causing compilation failure. `sql.js` uses WebAssembly, works everywhere without compilation.

---

### 5. KnowledgeGraph (`src/engine/knowledge-graph.ts`)

**Purpose:** Model relationships between files and concepts as a graph.

**Implementation:**
- Primary: `@ruvector/graph-node` (Rust NAPI, persistent, Cypher queries)
- Fallback: In-memory adjacency list (if native bindings fail)

**Graph Structure:**
```
[File Node] ──contains──→ [Concept Node] ←──contains── [File Node]
     │                                                        │
     └──────────── similar_to ────────────────────────────────┘
```

**Node Types:**
- `file` — represents an indexed file (properties: label, path, extension)
- `concept` — extracted from filenames and paths (e.g., "typescript", "auth", "config")

**Edge Types:**
- `contains` — file contains/relates to a concept
- `similar_to` — two files are semantically similar

**Related File Discovery:**
Uses 2-hop traversal: `file → concept → other_files_with_same_concept`

---

### 6. Indexer (`src/engine/indexer.ts`)

**Purpose:** Pipeline that processes file events into the storage layer.

**Pipeline:**
```
WatcherEvent → Queue → Batch Timer (500ms or 10 items)
                              │
                    ┌─────────▼──────────┐
                    │  For each event:    │
                    │  1. Extract content │
                    │  2. Hash check      │
                    │     (skip unchanged)│
                    │  3. ONNX embed      │
                    │  4. Vector upsert   │
                    │  5. Metadata upsert │
                    │  6. Graph update    │
                    │  7. Concept extract │
                    └────────────────────┘
```

**Batching Strategy:**
- Events accumulate in a queue
- Processed in batches of 10 (or after 500ms idle)
- This keeps the ONNX model loaded for consecutive embeddings
- For file deletions: immediately removes from all stores

**Concept Extraction:**
Extracts keywords from:
- Filename (split camelCase, kebab-case, snake_case)
- Path segments (last 3 directories)
- Language mapping (`.ts` → "typescript", `.py` → "python")

---

### 7. SearchEngine (`src/engine/search.ts`)

**Purpose:** Unified search combining vector similarity, graph traversal, and recency.

**Search Flow:**
```
Query text
    │
    ▼
ONNX Embed (query → 384-dim vector)
    │
    ▼
HNSW Search (find k*2 nearest vectors)
    │
    ▼
Metadata Lookup (get file records from SQLite)
    │
    ▼
Filter (by extension, directory)
    │
    ▼
Recency Boost (+10% for files modified in last 7 days)
    │
    ▼
Graph Traversal (find related files for top results)
    │
    ▼
Sort by score, limit to k results
    │
    ▼
Log search (for future GNN training)
```

---

### 8. DashboardServer (`src/dashboard/server.ts`)

**Purpose:** Web-based UI for search, monitoring, and visualization.

**Implementation:**
- Express HTTP server on port 3333
- WebSocket server for real-time updates (5-second status broadcasts)
- Single-page HTML/JS dashboard (no build step, no framework)
- Canvas-based knowledge graph visualization

**REST API:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/search` | POST | `{ query, limit, threshold }` → `{ results }` |
| `/api/status` | GET | Daemon status + indexer stats |
| `/api/config` | GET | Current configuration |
| `/api/graph` | GET | Graph nodes + edges for visualization |
| `/api/watch` | POST | `{ dir }` — add watch directory |
| `/api/watch` | DELETE | `{ dir }` — remove watch directory |

**WebSocket Events:**

| Event | Direction | Data |
|-------|-----------|------|
| `status` | Server → Client | Full daemon status (every 5s) |
| `indexed` | Server → Client | `{ path, name }` |
| `updated` | Server → Client | `{ path, name }` |
| `deleted` | Server → Client | `{ path }` |
| `log` | Server → Client | `{ message }` |

---

### 9. MCP Server (`src/mcp/server.ts`)

**Purpose:** Expose RuVector OS capabilities to AI agents via the Model Context Protocol.

**Transport:** stdio (standard input/output) for CLI integration.

**Tools:**

#### `search`
```
Input:  { query: string, limit?: number, threshold?: number, directory?: string, extensions?: string[] }
Output: Formatted text with ranked results, scores, previews, and related files
```

#### `related_files`
```
Input:  { path: string, limit?: number }
Output: List of related files with relevance percentages
```

#### `index_status`
```
Input:  {}
Output: Formatted text with daemon status, index stats, memory usage, watched dirs
```

#### `file_info`
```
Input:  { path: string }
Output: File metadata (name, extension, size, modified date, content preview, hash)
```

---

### 10. LaunchAgent (`src/daemon/launchagent.ts`)

**Purpose:** macOS service management for background daemon operation.

**Plist Configuration:**

| Key | Value | Purpose |
|-----|-------|---------|
| `RunAtLoad` | `true` | Start at login |
| `KeepAlive.SuccessfulExit` | `false` | Restart on crash |
| `ProcessType` | `Background` | Low-priority scheduling |
| `LowPriorityBackgroundIO` | `true` | Deprioritize I/O under load |
| `Nice` | `10` | Lower process priority |
| `ThrottleInterval` | `10` | Minimum seconds between restarts |

**Installation Path:** `~/Library/LaunchAgents/com.ruvector.memory.plist`

---

## Data Flow Diagrams

### File Change → Index

```
1. FSEvents (kernel) detects file write
2. chokidar receives event, filters by extension/size
3. Indexer queues the event
4. Batch timer fires (500ms or 10 items)
5. For each file:
   a. Read content (fs.readFile)
   b. Hash content (SHA-256, first 16 chars)
   c. Check MetadataDb — skip if hash unchanged
   d. ONNX embed content → 384-dim Float32Array
   e. VectorStore.upsert(id, vector, metadata)
   f. MetadataDb.upsertFile(record)
   g. KnowledgeGraph.addFileNode(id, name, metadata)
   h. Extract concepts from filename/path
   i. KnowledgeGraph.connectFileToConcept(fileId, conceptId)
6. Dashboard receives WebSocket notification
```

### Search Query → Results

```
1. User enters query (CLI, dashboard, or MCP)
2. ONNX embed query → 384-dim vector (~10ms)
3. VectorStore.search(vector, k=20) → ranked IDs (<1ms)
4. MetadataDb.getFile(id) for each result
5. Apply filters (extension, directory)
6. Recency boost (+0-10% for recent files)
7. KnowledgeGraph.getRelatedFiles(id, 3) for top results
8. Sort by final score, limit to requested k
9. Log search query + result IDs (for future learning)
10. Return formatted results
```

---

## Concurrency Model

- **Single Node.js process** — event loop handles all I/O
- **FSEvents** — kernel-level batching, near-zero overhead
- **ONNX inference** — runs on CPU thread pool (via onnxruntime-node), non-blocking
- **VectorStore** — native Rust operations, non-blocking via NAPI
- **MetadataDb** — synchronous WASM SQLite (fast enough for single-process use)
- **Dashboard** — Express async handlers, WebSocket broadcasts

The main thread orchestrates; compute-heavy work (embedding, HNSW search) happens in native threads via NAPI.

---

## Error Handling

| Scenario | Handling |
|----------|---------|
| File read fails | Skip file, increment error counter |
| ONNX inference fails | Log error, skip file |
| Vector insert fails | Log error, continue |
| Database corruption | sql.js: create fresh on open failure |
| Graph init fails | Fall back to in-memory adjacency list |
| Dashboard port in use | Report error and exit |
| SIGTERM during indexing | Flush queue, close all stores, exit 0 |
| MetadataDb accessed after close | Return empty stats (graceful degradation) |

---

## Future Architecture Considerations

### Tier 2: Learning Layer — IMPLEMENTED

The learning subsystem (`src/engine/learning-engine.ts`, `gnn-ranker.ts`, `similarity-sweep.ts`) is code-complete:
1. **LearningEngine** — Records clicks, computes importance scores with decay, provides learning metrics
2. **GnnRanker** — Uses `@ruvector/gnn` native bindings to re-rank search results based on learned preferences
3. **SimilaritySweep** — Periodic background sweep samples files, discovers similar pairs, creates `similar_to` edges in the knowledge graph (battery-aware — defers on low charge)

### Tier 3: Adaptive Intelligence — IMPLEMENTED

The adaptive intelligence subsystem (`src/engine/query-expander.ts`, `context-tracker.ts`, `auto-tagger.ts`) is code-complete:
1. **QueryExpander** — Auto-expands sparse queries using related terms from search history and embedding similarity
2. **ContextTracker** — Boosts recently accessed files in search results; records context events for temporal awareness
3. **AutoTagger** — Clusters indexed files by embedding similarity, assigns human-readable topic tags (battery-aware)
4. **SearchAnalytics** — Top queries, daily volume, click-through rate metrics

### Security Hardening — IMPLEMENTED

1. **Prompt injection mitigation** (`src/shared/sanitize.ts`) — All file content in MCP responses is wrapped in `[FILE_CONTENT]` delimiters with a data preamble. Control characters stripped at ingestion.
2. **Dashboard XSS protection** — All dynamic values escaped via `esc()` before innerHTML interpolation.

### Tier 3: Native UI Layer

Tauri application (~30MB RAM overhead):
- Menu bar icon with search input
- Global hotkey registration (Carbon API or Swift helper)
- IPC to running daemon via HTTP API

### Tier 4: Distributed Knowledge

ruvector supports Raft consensus and multi-master replication. Future team features could:
- Share knowledge graphs between Macs on a local network
- Merge embeddings and connections from multiple users
- Provide "institutional knowledge" to new team members

---

## File Map

```
src/
├── index.ts                    # Library exports
├── cli/
│   └── cli.ts                  # CLI entry point (commander, 9 commands)
├── daemon/
│   ├── daemon.ts               # Main orchestrator (init, start, stop, search)
│   ├── config.ts               # JSON config load/save/update
│   └── launchagent.ts          # macOS LaunchAgent plist management
├── watcher/
│   └── fs-watcher.ts           # File system watcher (chokidar, FSEvents)
├── embeddings/
│   └── onnx-embedder.ts        # ONNX inference (embed, tokenize, lazy load)
├── engine/
│   ├── vector-store.ts         # HNSW vector index (ruvector)
│   ├── metadata-db.ts          # SQLite metadata (sql.js), 768 lines
│   ├── knowledge-graph.ts      # Graph DB (@ruvector/graph-node + fallback)
│   ├── indexer.ts              # Batch indexing pipeline
│   ├── search.ts               # Unified search engine (vector + graph + learning)
│   ├── learning-engine.ts      # Tier 2: click tracking, importance scores, decay
│   ├── gnn-ranker.ts           # Tier 2: GNN re-ranking via @ruvector/gnn
│   ├── similarity-sweep.ts     # Tier 2: periodic similar-file discovery (battery-aware)
│   ├── query-expander.ts       # Tier 3: auto-expand sparse queries
│   ├── context-tracker.ts      # Tier 3: context-aware search boosting
│   └── auto-tagger.ts          # Tier 3: embedding-based file clustering & tagging (battery-aware)
├── mcp/
│   └── server.ts               # MCP server (7 tools, stdio transport, injection-hardened)
├── dashboard/
│   └── server.ts               # Web dashboard (Express + WS + inline HTML, XSS-safe)
└── shared/
    ├── types.ts                # TypeScript interfaces and defaults
    ├── paths.ts                # All file system paths (centralized)
    ├── utils.ts                # Hash, extract, format utilities (+ PDF extraction)
    ├── sanitize.ts             # Security: MCP content wrapping, HTML escaping
    └── battery.ts              # macOS battery detection (pmset)
```

Test files:
```
src/
├── shared/
│   ├── sanitize.test.ts        # Content wrapping, HTML escaping, injection strings
│   └── utils.test.ts           # contentHash, fileId, shouldIndex, extractContent, formatBytes
└── engine/
    └── metadata-db.test.ts     # Full CRUD, search history, importance, tags, context, analytics
```

Total: **25 source files** + **3 test files**, ~4,500+ lines of TypeScript.
