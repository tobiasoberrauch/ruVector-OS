# RuVector OS — Feature Roadmap

**Last updated:** February 2026
**Current version:** 0.1.0
**Status:** Tiers 1-3 implemented (partial), Tier 4 planned

---

## Completion Summary

| Phase | Status | Progress |
|-------|--------|----------|
| Phase 1 — Hardening & Polish | Next up | 0 / 7 |
| Phase 2 — Content Intelligence | Planned | 0 / 5 |
| Phase 3 — Native macOS Experience | Planned | 0 / 6 |
| Phase 4 — Encryption & Trust | Planned | 0 / 4 |
| Phase 5 — Advanced Intelligence | Planned | 0 / 6 |
| Phase 6 — Distribution & Community | Planned | 0 / 5 |

---

## What's Already Done

Before the roadmap — here's what's implemented and working:

- **Core daemon**: FSEvents watcher, ONNX embedding (all-MiniLM-L6-v2, 384-dim), HNSW vector search (<1ms), SQLite metadata, knowledge graph
- **CLI**: init, start, stop, status, search, watch add/remove/list, mcp-server, uninstall
- **MCP server**: 7 tools (search, related_files, index_status, file_info, + 3 more), stdio transport, prompt injection mitigation
- **Dashboard**: search UI, stats, graph visualization, real-time WebSocket updates, XSS-safe
- **Learning**: GNN re-ranking, click tracking, importance scores with decay, learning metrics
- **Adaptive**: query expansion, context-aware boosting, auto-tagging, search analytics
- **Infrastructure**: battery-aware scheduling, PDF extraction, control char stripping, test suite (vitest)

**25 source files + 3 test files, ~4,500+ lines of TypeScript.**

---

## Phase 1 — Hardening & Polish

**Goal:** Make the existing system production-ready. Fix gaps, improve test coverage, polish the developer experience.

**Estimated effort:** 1-2 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 1.1 | **Duplicate file detection** | Use similarity sweep results to surface exact and near-duplicate files via CLI/dashboard/MCP. The sweep already discovers similar pairs — this adds a dedicated UI and a `duplicates` MCP tool. | P1 | similarity-sweep.ts |
| 1.2 | **"Related files" panel in dashboard** | Add a sidebar or section to the dashboard that shows related files when clicking a search result. Engine support exists (`getRelatedFiles`), just needs frontend wiring. | P1 | search.ts, dashboard/server.ts |
| 1.3 | **Configuration management UI** | Dashboard panel to view and edit config (watch dirs, extensions, thresholds) without touching `config.json` manually. REST endpoints `/api/config` GET already exists — add PUT + UI form. | P2 | dashboard/server.ts, config.ts |
| 1.4 | **Expand test coverage** | Add tests for: indexer pipeline (end-to-end), search engine (with mocked stores), knowledge graph, similarity sweep, auto-tagger, query expander. Target: >80% coverage on engine/. | P1 | vitest, existing test files |
| 1.5 | **Vector DB lock cleanup** | On daemon init, detect and clean stale lock files from crashed previous runs. Currently a known issue that requires manual intervention. | P1 | vector-store.ts, daemon.ts |
| 1.6 | **Graceful ONNX model error recovery** | If the ONNX model fails to load (corrupted download, missing file), provide a clear error message and offer re-download via CLI. Currently fails silently. | P2 | onnx-embedder.ts, cli.ts |
| 1.7 | **Stress test hardening** | Run the existing `scripts/stress-test.ts` against 10K+ files, identify and fix memory leaks, slow paths, and edge cases. Add CI-compatible performance benchmarks. | P2 | scripts/stress-test.ts |

---

## Phase 2 — Content Intelligence

**Goal:** Expand what RuVector can understand. More file types, smarter extraction, richer metadata.

**Estimated effort:** 2-3 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 2.1 | **Image OCR for screenshots** | Extract text from PNG/JPG/TIFF screenshots using macOS Vision framework (via Swift helper or `osascript`) or Tesseract.js. Makes screenshots searchable. (FR-1.11) | P2 | utils.ts extractContent() |
| 2.2 | **Markdown/frontmatter extraction** | Parse YAML frontmatter from `.md` files to extract structured metadata (title, tags, date, author). Use these as additional concept nodes in the knowledge graph. | P2 | indexer.ts, knowledge-graph.ts |
| 2.3 | **Code-aware chunking** | For source code files, chunk by function/class boundaries instead of raw character slicing. Produces better embeddings for code search. Use tree-sitter or simple regex-based splitters for top languages (TS, Python, Rust, Go). | P2 | utils.ts, indexer.ts |
| 2.4 | **Multi-vector per file** | Store multiple embeddings per large file (one per chunk/section). Improves search precision for long documents where different sections have different meanings. Requires VectorStore ID scheme change (fileId:chunkN). | P2 | vector-store.ts, indexer.ts, search.ts |
| 2.5 | **Content change diffing** | When a file is re-indexed, detect what changed and only re-embed modified sections (for multi-vector files). Reduces ONNX computation on file updates. | P3 | indexer.ts |

---

## Phase 3 — Native macOS Experience

**Goal:** Bring RuVector from a CLI/dashboard tool to a first-class macOS citizen with system-level integration.

**Estimated effort:** 3-4 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 3.1 | **Tauri menu bar app** | Lightweight (~30MB) Tauri app that sits in the macOS menu bar. Shows a search input, recent results, and daemon status. Communicates with the running daemon via HTTP API. | P2 | dashboard REST API |
| 3.2 | **Global hotkey (Cmd+Shift+Space)** | Register a system-wide hotkey that opens the menu bar search. Uses Tauri's global shortcut API or a Swift helper. | P2 | Tauri app (3.1) |
| 3.3 | **Clipboard history with semantic search** | Opt-in clipboard monitoring. Store clipboard entries with timestamps and embeddings. Search clipboard history semantically ("that URL I copied yesterday"). | P2 | metadata-db.ts, vector-store.ts |
| 3.4 | **TCC / Full Disk Access flow** | Package as a signed `.app` bundle to enable TCC consent dialogs. Guide users through granting Full Disk Access to index ~/Documents, ~/Desktop, ~/Downloads. | P2 | Tauri app (3.1), launchagent.ts |
| 3.5 | **Notification integration** | macOS notifications when: indexing completes after adding a new directory, learning milestones hit, or duplicate files detected. Via `osascript` or Tauri notification API. | P3 | daemon.ts |
| 3.6 | **Dark/light mode auto-detection** | Dashboard and Tauri app adapt to macOS appearance setting. Dashboard currently uses a dark theme — add light theme variant with `prefers-color-scheme` media query. | P3 | dashboard/server.ts |

---

## Phase 4 — Encryption & Trust

**Goal:** Protect indexed data at rest. Essential for users indexing sensitive documents.

**Estimated effort:** 1-2 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 4.1 | **SQLCipher encryption** | Encrypt the SQLite metadata database. Research sql.js WASM compatibility with SQLCipher or evaluate switching to better-sqlite3 with SQLCipher extension (requires solving the Node 24 + Python 3.14 build issue). | P2 | metadata-db.ts |
| 4.2 | **macOS Keychain key storage** | Store the SQLCipher encryption key in the macOS Keychain (Secure Enclave on Apple Silicon). Use `security` CLI or a Swift helper for Keychain access. | P2 | SQLCipher (4.1) |
| 4.3 | **Vector database encryption** | Evaluate encryption options for the ruvector HNSW index. Options: encrypt at the filesystem level (APFS encrypted volume), or add an encryption wrapper around the storage path. | P3 | vector-store.ts |
| 4.4 | **Code signing** | Sign the binary/app bundle with a Developer ID certificate. Enables Gatekeeper trust, notarization, and protects against tampering. Required for distribution outside npm. | P3 | Tauri app (3.1) |

---

## Phase 5 — Advanced Intelligence

**Goal:** Push beyond search into true knowledge understanding. Temporal awareness, graph queries, and intelligent organization.

**Estimated effort:** 3-5 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 5.1 | **Temporal queries** | Answer "what was I working on last Tuesday?" by combining file modification timestamps, context tracker events, and search history. Add a `temporal_search` MCP tool. | P2 | context-tracker.ts, metadata-db.ts |
| 5.2 | **Full Cypher graph queries** | Expose the `@ruvector/graph-node` Cypher query engine via MCP and dashboard. Users can run arbitrary graph queries like `MATCH (f:file)-[:contains]->(c:concept) WHERE c.label = 'auth' RETURN f`. | P2 | knowledge-graph.ts, mcp/server.ts |
| 5.3 | **Smart folder suggestions** | Analyze file clusters from auto-tagging and suggest logical folder reorganizations. "These 12 TypeScript files about authentication are scattered across 4 directories — consider grouping them." Read-only suggestions, never moves files. | P3 | auto-tagger.ts |
| 5.4 | **Export to Obsidian** | Generate an Obsidian vault from the knowledge graph. Each file becomes a note with `[[wikilinks]]` to related files and concept tags. Concepts become index notes. | P3 | knowledge-graph.ts, metadata-db.ts |
| 5.5 | **Export to Notion** | Push the knowledge graph to a Notion database via Notion API. Files as pages, concepts as tags/relations, similarity edges as related page links. | P3 | knowledge-graph.ts |
| 5.6 | **Multi-model support** | Allow swapping ONNX models (e.g., all-MiniLM-L12-v2 for higher accuracy, or a larger model for richer embeddings). Config-driven model selection with dimension auto-detection. Requires re-indexing on model change. | P3 | onnx-embedder.ts, config.ts |

---

## Phase 6 — Distribution & Community

**Goal:** Make RuVector installable and usable by anyone, not just developers building from source.

**Estimated effort:** 2-3 weeks

| # | Feature | Description | Priority | Builds on |
|---|---------|-------------|----------|-----------|
| 6.1 | **npm global install** | Publish to npm as `ruvector-os`. `npm install -g ruvector-os && ruvector-memory init && ruvector-memory start` just works. Handle native dependency bundling (onnxruntime-node, ruvector). | P1 | package.json |
| 6.2 | **Homebrew formula** | Create a Homebrew tap (`brew install ruvector-os`). Bundle pre-built native modules for Apple Silicon and Intel. Include LaunchAgent auto-setup. | P2 | build system |
| 6.3 | **.dmg installer** | For the Tauri app: signed .dmg with drag-to-Applications install. Includes the menu bar app, CLI tools, and LaunchAgent. | P3 | Tauri app (3.1), code signing (4.4) |
| 6.4 | **Documentation site** | Static site (VitePress or Astro) with: getting started, configuration reference, MCP integration guide, API docs, architecture overview. Host on GitHub Pages. | P2 | docs/ |
| 6.5 | **Team knowledge sharing** | Experimental: use ruvector's Raft consensus support for multi-master replication between Macs on a local network. Share knowledge graphs and embeddings across a team. | P3 | ruvector, knowledge-graph.ts |

---

## Dependency Graph

```
Phase 1 (Hardening)
  └─→ Phase 2 (Content Intelligence)
  └─→ Phase 4 (Encryption)
  └─→ Phase 6.1-6.2 (npm / Homebrew)

Phase 3 (Native macOS)
  ├── 3.1 Tauri app
  │   ├─→ 3.2 Global hotkey
  │   ├─→ 3.4 TCC flow
  │   ├─→ 3.5 Notifications
  │   └─→ 6.3 .dmg installer
  └── 3.3 Clipboard (independent)

Phase 4 (Encryption)
  ├── 4.1 SQLCipher
  │   └─→ 4.2 Keychain
  └── 4.4 Code signing
      └─→ 6.3 .dmg installer

Phase 5 (Advanced Intelligence)
  └── All items are independent; can be built in any order
      5.1 Temporal queries (needs context-tracker)
      5.2 Cypher queries (needs graph-node)
      5.4-5.5 Exports (need knowledge graph)
```

---

## Recommended Execution Order

For a solo developer, this sequence maximizes impact while respecting dependencies:

### Near-term (next 2-3 weeks)
1. **1.5** Vector DB lock cleanup — fix the most annoying known issue
2. **1.1** Duplicate file detection — low-hanging fruit, infrastructure exists
3. **1.2** Related files panel — same, just needs frontend wiring
4. **1.4** Expand test coverage — safety net before larger changes
5. **1.3** Configuration management UI — quality of life

### Mid-term (weeks 4-8)
6. **2.1** Image OCR — high user value, makes screenshots searchable
7. **2.3** Code-aware chunking — major improvement for developer use case
8. **5.1** Temporal queries — differentiating feature, builds on existing context tracker
9. **5.2** Cypher graph queries — expose existing capability via MCP
10. **4.1 + 4.2** SQLCipher + Keychain — security milestone

### Longer-term (weeks 9+)
11. **3.1 + 3.2** Tauri app + global hotkey — the flagship UX improvement
12. **6.1** npm global install — first distribution channel
13. **2.4** Multi-vector per file — search quality leap
14. **5.4** Obsidian export — popular integration target
15. **6.2** Homebrew formula — wider distribution

---

*This is a living document. Features may be reordered based on user feedback and technical discoveries.*
