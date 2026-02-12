# RuVector vs Phago — Comparative Analysis

## Identity

| | **RuVector** | **Phago** |
|---|---|---|
| **Tagline** | "The vector database that gets smarter the more you use it" | "Biological computing primitives" |
| **Core metaphor** | Database infrastructure + ML | Cellular biology → computation |
| **Repo** | [github.com/ruvnet/ruvector](https://github.com/ruvnet/ruvector) | Local / [github.com/Clemens865/Phago_Project](https://github.com/Clemens865/Phago_Project) |
| **Language** | Rust (21.9M) + TS/JS (6.6M) | Rust (~pure) |
| **Crate count** | 75+ | 14 |
| **Version** | Multi-crate (various) | 1.0.0 |
| **Stars / Forks** | 301 / 93 | — |
| **License** | MIT | MIT |
| **Maturity** | Broad, many capabilities | Deep, one paradigm fully realized |

---

## Philosophical Difference

This is the most important distinction:

**RuVector** is an **infrastructure product** — it's a vector database that happens to learn. The GNN layer improves results over time, but the core API is still `store embeddings → query → get results`. It's designed to replace Pinecone/Weaviate with a smarter alternative.

**Phago** is a **computational model** — it maps biological mechanisms to knowledge construction. There's no "store and query" API; instead, you spawn a colony of agents that *digest* documents, *wire* knowledge through Hebbian learning, *die* via apoptosis, and *evolve*. The knowledge graph isn't a database — it's an emergent structure that grows organically.

> RuVector adds learning to a database. Phago uses biology to build knowledge from scratch.

---

## Feature-by-Feature Comparison

### Learning Mechanism

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **How it learns** | GNN multi-head attention over query history | Hebbian LTP — edges strengthen with co-activation, decay without it |
| **What learns** | The index/ranking layer | The entire knowledge graph topology |
| **Learning signal** | Query patterns (implicit feedback) | Document co-occurrence + agent behavior + fitness |
| **Forgetting** | Not emphasized | Built-in: synaptic decay prunes weak edges (98.3% edge reduction) |
| **Evolution** | None | Full: fitness, mutation, inheritance, apoptosis (11.6x edge richness) |

**Verdict:** Phago's learning is deeper and more biologically grounded. RuVector's is more practically useful for production search. They learn different things for different purposes.

---

### Graph Capabilities

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **Query language** | Cypher (`MATCH (a)-[:SIMILAR]->(b)`) | Structural queries (path, centrality, bridges, components) |
| **Graph type** | Similarity graph from embeddings | Hebbian knowledge graph from co-activation |
| **Graph construction** | Computed from vector proximity | Emerges from agent behavior |
| **Community detection** | Not emphasized | Louvain (NMI = 1.000 perfect) |
| **Explainability** | Similarity scores | Full path traces with weights and co-activation counts |

**Verdict:** RuVector has a richer query language (Cypher). Phago has richer graph semantics (edges carry temporal/behavioral meaning).

---

### Distributed Systems

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **Consensus** | Raft consensus, multi-master replication | Consistent hash ring + coordinator |
| **Sharding** | Auto-sharding across nodes | Consistent hashing with 150 virtual nodes |
| **Fault tolerance** | Vector clocks, conflict resolution | Ghost nodes for lazy cross-shard resolution |
| **Scale** | Burst scaling (10-50x), geo-distributed | 3+ shards, phase-synchronized ticks |
| **Maturity** | Production-oriented, many protocols | Proven (155+ tests) but research-focused |

**Verdict:** RuVector is significantly more mature for distributed production deployments. Phago's distributed model is functional but designed for colony simulation, not massive-scale serving.

---

### AI / LLM Integration

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **Local LLMs** | ruvllm — full GGUF runtime with Metal/CUDA/ANE | Ollama backend (external process) |
| **Cloud LLMs** | Via router | Claude, OpenAI, Ollama backends |
| **Embeddings** | Built-in ONNX, HNSW indexing | SimpleEmbedder (hash-based) + ONNX + API providers |
| **MCP** | Full MCP server with tool ecosystem | MCP adapter (3 tools: remember, recall, explore) |
| **Attention** | 39 mechanisms (flash, linear, graph, hyperbolic...) | None (not its domain) |

**Verdict:** RuVector has a massive AI/ML toolkit. Phago is deliberately LLM-light — its v1 thesis is that emergence doesn't need external intelligence.

---

### Agent Model

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **Agent types** | External (Claude-Flow, Agentic-Flow integration) | Built-in: Digester, Synthesizer, Sentinel |
| **Agent behavior** | Task-based (assigned work) | Autonomous (sense → act → die lifecycle) |
| **Self-organization** | No (orchestrated top-down) | Yes (quorum sensing, stigmergy, chemotaxis) |
| **Evolution** | No | Yes (genome, fitness, mutation, inheritance) |
| **Anomaly detection** | Not built-in | Sentinel agent with negative selection |

**Verdict:** Phago wins definitively here. Its agents are true autonomous entities with biological primitives. RuVector's "agents" are external orchestration clients.

---

### Platform Targets

| Aspect | RuVector | Phago |
|--------|----------|-------|
| **Native** | Yes (primary) | Yes (primary) |
| **WASM** | Yes (extensive, per-crate) | Planned (phago-wasm crate exists) |
| **Node.js** | Yes (N-API bindings, npm packages) | No |
| **Python** | No | Yes (PyO3 with LangChain/LlamaIndex) |
| **PostgreSQL** | Yes (pgvector extension) | No |
| **Browser** | Yes (WASM) | Future |
| **Edge/IoT** | rvlite | No |

**Verdict:** RuVector has far broader platform coverage. Phago has Python bindings RuVector lacks.

---

### Retrieval Performance

| Metric | RuVector | Phago |
|--------|----------|-------|
| **Search method** | HNSW + GNN re-ranking | TF-IDF candidates + Hebbian graph re-ranking |
| **MRR** | Not published (benchmark suite exists) | **0.800** (hybrid) vs 0.775 (TF-IDF baseline) |
| **P@5** | Not published | **0.742** (hybrid, matches TF-IDF) |
| **NDCG@10** | Not published | **0.410** (hybrid) |
| **Latency** | Sub-ms HNSW + GNN overhead | Higher (BFS traversal over graph edges) |
| **Improves over time** | Yes (GNN learns from queries) | Yes (Hebbian reinforcement from usage) |

---

### The Ten Biological Primitives (Phago-Only)

These have no equivalent in RuVector:

| Primitive | Biological Analog | What It Does |
|-----------|-------------------|-------------|
| **DIGEST** | Phagocytosis | Consume input, extract fragments, present to graph |
| **APOPTOSE** | Programmed cell death | Self-assess health, gracefully self-terminate |
| **SENSE** | Chemotaxis | Detect signals, follow gradients |
| **TRANSFER** | Horizontal gene transfer | Export/import vocabulary between agents |
| **EMERGE** | Quorum sensing | Detect threshold, activate collective behavior |
| **WIRE** | Hebbian learning | Strengthen used connections, prune unused |
| **SYMBIOSE** | Endosymbiosis | Integrate another agent as permanent symbiont |
| **STIGMERGE** | Stigmergy | Coordinate through environmental traces |
| **NEGATE** | Negative selection | Learn self-model, detect anomalies by exclusion |
| **DISSOLVE** | Holobiont boundary | Modulate agent-substrate boundaries |

---

### RuVector's Unique Capabilities (No Phago Equivalent)

| Capability | Description |
|------------|-------------|
| **39 attention mechanisms** | Flash, linear, graph, hyperbolic, mincut-gated |
| **ruvllm** | Full local LLM runtime (GGUF, Metal/CUDA/ANE) |
| **Cypher queries** | Neo4j-style graph query language |
| **pgvector extension** | Drop-in PostgreSQL compatibility |
| **Spiking neural networks** | Event-driven neuromorphic computing |
| **FPGA transformer** | Hardware-accelerated inference |
| **Quantum coherence (ruQu)** | Quantum error correction abstractions |
| **Economy system** | Tokenomics with CRDT-based state |
| **RuvLTRA models** | Pre-trained GGUF for routing & embeddings (<10ms) |
| **Burst scaling** | 10-50x capacity for traffic spikes |

---

## Where They're Complementary (Not Competing)

These projects don't actually compete — they operate at different layers:

```
┌─────────────────────────────────────────────┐
│  Application Layer                           │
│  (Search, RAG, Agents, etc.)                │
├─────────────────────────────────────────────┤
│  RuVector                                    │
│  Vector storage, HNSW indexing, GNN ranking, │
│  distributed infra, LLM runtime              │
├─────────────────────────────────────────────┤
│  Phago                                       │
│  Knowledge construction, biological agents,  │
│  emergent graph building, evolution           │
├─────────────────────────────────────────────┤
│  Raw Data (documents, embeddings, signals)   │
└─────────────────────────────────────────────┘
```

**Phago builds knowledge. RuVector stores and serves it.**

---

## Integration Opportunity

The most compelling synergy: **Phago as the knowledge construction engine that feeds RuVector as the serving layer.**

1. Phago colony digests documents → builds Hebbian knowledge graph → evolves agent strategies
2. The matured graph exports to RuVector as vectors + graph edges
3. RuVector's GNN layer learns from query patterns on top of Phago's structural knowledge
4. RuVector serves at scale (WASM, edge, distributed) what Phago built through emergence

This gives you:
- **Phago's biological learning** (deeper, emergent, self-healing)
- **RuVector's production serving** (fast, distributed, multi-platform)
- **Two layers of learning** — construction-time (Hebbian) + query-time (GNN)

---

## Summary Scorecard

| Dimension | RuVector | Phago | Notes |
|-----------|:--------:|:-----:|-------|
| Production readiness | ★★★★★ | ★★★☆☆ | RuVector ships npm packages, platform binaries |
| Learning depth | ★★★☆☆ | ★★★★★ | Phago's biological model is fundamentally deeper |
| Agent autonomy | ★★☆☆☆ | ★★★★★ | Phago agents self-organize; RuVector delegates externally |
| Distributed scale | ★★★★★ | ★★★☆☆ | RuVector has Raft, multi-master, burst scaling |
| Platform coverage | ★★★★★ | ★★☆☆☆ | RuVector: WASM, Node, Postgres, edge. Phago: Rust + Python |
| AI/ML toolkit | ★★★★★ | ★★☆☆☆ | 39 attention mechanisms, local LLMs, FPGA, quantum |
| Explainability | ★★☆☆☆ | ★★★★★ | Phago provides full path traces with behavioral context |
| Novelty | ★★★☆☆ | ★★★★★ | Phago's biological primitives are genuinely novel |
| Community detection | ★★☆☆☆ | ★★★★★ | Phago achieves NMI = 1.000 with Louvain |
| Ecosystem | ★★★★★ | ★★☆☆☆ | RuVector powers Claude-Flow + Agentic-Flow |
| Scope | ★★★★★ | ★★★☆☆ | RuVector: 75 crates. Phago: 14 focused crates |
| Research depth | ★★★☆☆ | ★★★★★ | Phago has 4 falsifiable hypotheses with benchmarks |

---

*Analysis date: February 2026*
