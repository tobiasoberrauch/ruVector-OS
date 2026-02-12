#!/usr/bin/env npx tsx
/**
 * RuVector OS — Stress Test (1K+ files)
 *
 * Generates a realistic corpus of 1,200+ files, indexes them in-process
 * (full pipeline: extract → embed → vector store → metadata → graph),
 * runs search queries, and reports performance metrics.
 *
 * Usage:
 *   npx tsx scripts/stress-test.ts
 *
 * Requirements:
 *   - ONNX model downloaded (run `ruvector-memory init` first)
 *   - No other ruvector daemon running (vector DB file lock)
 *
 * What it measures:
 *   - Indexing throughput (files/sec)
 *   - Embedding latency (ms/file)
 *   - Search latency (end-to-end ms)
 *   - Memory usage (RSS, heap)
 *   - Storage size on disk
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';

// ── File generation ────────────────────────────────────────

const CORPUS_SIZE = 1200;
const TEST_DIR = join(tmpdir(), `ruvector-stress-${Date.now()}`);

/** Content templates by category — realistic, varied text */
const TEMPLATES = {
  typescript: (i: number) => [
    `import { Injectable } from '@nestjs/common';`,
    `import { Repository } from 'typeorm';`,
    ``,
    `/**`,
    ` * Service ${i}: handles business logic for feature module ${i}.`,
    ` * Manages data access, validation, and event emission.`,
    ` */`,
    `@Injectable()`,
    `export class Service${i} {`,
    `  constructor(private repo: Repository<Entity${i}>) {}`,
    ``,
    `  async findAll(page = 1, limit = 20) {`,
    `    return this.repo.find({ skip: (page - 1) * limit, take: limit });`,
    `  }`,
    ``,
    `  async findById(id: string) {`,
    `    const entity = await this.repo.findOne({ where: { id } });`,
    `    if (!entity) throw new NotFoundException('Entity not found');`,
    `    return entity;`,
    `  }`,
    ``,
    `  async create(dto: CreateDto${i}) {`,
    `    const entity = this.repo.create(dto);`,
    `    return this.repo.save(entity);`,
    `  }`,
    ``,
    `  async update(id: string, dto: UpdateDto${i}) {`,
    `    await this.repo.update(id, dto);`,
    `    return this.findById(id);`,
    `  }`,
    ``,
    `  async remove(id: string) {`,
    `    await this.repo.delete(id);`,
    `  }`,
    `}`,
  ].join('\n'),

  python: (i: number) => [
    `"""Module ${i}: data processing pipeline."""`,
    `import pandas as pd`,
    `import numpy as np`,
    `from typing import Optional`,
    ``,
    `class DataProcessor${i}:`,
    `    """Process and transform dataset ${i}."""`,
    ``,
    `    def __init__(self, source: str, chunk_size: int = 1000):`,
    `        self.source = source`,
    `        self.chunk_size = chunk_size`,
    `        self._cache: Optional[pd.DataFrame] = None`,
    ``,
    `    def load(self) -> pd.DataFrame:`,
    `        df = pd.read_csv(self.source, chunksize=self.chunk_size)`,
    `        self._cache = pd.concat(df)`,
    `        return self._cache`,
    ``,
    `    def transform(self, columns: list[str]) -> pd.DataFrame:`,
    `        if self._cache is None:`,
    `            self.load()`,
    `        result = self._cache[columns].dropna()`,
    `        result['normalized'] = (result - result.mean()) / result.std()`,
    `        return result`,
    ``,
    `    def aggregate(self, group_by: str, agg_func: str = 'mean'):`,
    `        return self._cache.groupby(group_by).agg(agg_func)`,
  ].join('\n'),

  markdown: (i: number) => {
    const topics = [
      'Authentication', 'Database Schema', 'API Design', 'Deployment',
      'Testing Strategy', 'Performance', 'Security', 'Monitoring',
      'Error Handling', 'Configuration', 'Caching', 'Logging',
    ];
    const topic = topics[i % topics.length];
    return [
      `# ${topic} — Design Document ${i}`,
      ``,
      `## Overview`,
      `This document describes the ${topic.toLowerCase()} approach for the system.`,
      `The design prioritizes reliability, scalability, and maintainability.`,
      ``,
      `## Requirements`,
      `- Must handle ${1000 * (i + 1)} concurrent requests`,
      `- Response latency under 50ms at p99`,
      `- Zero data loss during failover`,
      ``,
      `## Architecture`,
      `The ${topic.toLowerCase()} layer sits between the API gateway and the data store.`,
      `It uses a combination of in-memory caching and persistent storage.`,
      ``,
      `## Implementation Notes`,
      `- Use connection pooling with max ${10 + i} connections`,
      `- Implement circuit breaker pattern for external dependencies`,
      `- Add structured logging for observability`,
      ``,
      `## Open Questions`,
      `1. Should we use Redis or Memcached for the cache layer?`,
      `2. How do we handle cache invalidation across multiple instances?`,
    ].join('\n');
  },

  rust: (i: number) => [
    `//! Module ${i}: concurrent data structure`,
    `use std::sync::{Arc, RwLock};`,
    `use std::collections::HashMap;`,
    ``,
    `pub struct ConcurrentMap${i}<K, V> {`,
    `    inner: Arc<RwLock<HashMap<K, V>>>,`,
    `    capacity: usize,`,
    `}`,
    ``,
    `impl<K: Eq + std::hash::Hash + Clone, V: Clone> ConcurrentMap${i}<K, V> {`,
    `    pub fn new(capacity: usize) -> Self {`,
    `        Self {`,
    `            inner: Arc::new(RwLock::new(HashMap::with_capacity(capacity))),`,
    `            capacity,`,
    `        }`,
    `    }`,
    ``,
    `    pub fn get(&self, key: &K) -> Option<V> {`,
    `        self.inner.read().unwrap().get(key).cloned()`,
    `    }`,
    ``,
    `    pub fn insert(&self, key: K, value: V) -> Option<V> {`,
    `        self.inner.write().unwrap().insert(key, value)`,
    `    }`,
    ``,
    `    pub fn len(&self) -> usize {`,
    `        self.inner.read().unwrap().len()`,
    `    }`,
    `}`,
  ].join('\n'),

  json: (i: number) => JSON.stringify({
    name: `package-${i}`,
    version: `${Math.floor(i / 100)}.${Math.floor((i % 100) / 10)}.${i % 10}`,
    description: `Configuration for module ${i} with custom settings`,
    dependencies: {
      express: '^4.18.0',
      lodash: '^4.17.21',
      axios: '^1.6.0',
    },
    scripts: {
      build: 'tsc',
      test: 'vitest run',
      lint: 'eslint src/',
    },
    config: {
      port: 3000 + i,
      maxConnections: 100 + i,
      logLevel: i % 3 === 0 ? 'debug' : i % 3 === 1 ? 'info' : 'warn',
    },
  }, null, 2),

  sql: (i: number) => [
    `-- Migration ${i}: create tables for feature module`,
    `CREATE TABLE IF NOT EXISTS entities_${i} (`,
    `  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),`,
    `  name VARCHAR(255) NOT NULL,`,
    `  description TEXT,`,
    `  status VARCHAR(50) DEFAULT 'active',`,
    `  metadata JSONB DEFAULT '{}',`,
    `  created_at TIMESTAMP DEFAULT NOW(),`,
    `  updated_at TIMESTAMP DEFAULT NOW()`,
    `);`,
    ``,
    `CREATE INDEX idx_entities_${i}_name ON entities_${i}(name);`,
    `CREATE INDEX idx_entities_${i}_status ON entities_${i}(status);`,
    ``,
    `INSERT INTO entities_${i} (name, description) VALUES`,
    `  ('Item A', 'First item in module ${i}'),`,
    `  ('Item B', 'Second item in module ${i}');`,
  ].join('\n'),

  yaml: (i: number) => [
    `# Service ${i} deployment configuration`,
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `metadata:`,
    `  name: service-${i}`,
    `  labels:`,
    `    app: service-${i}`,
    `    tier: backend`,
    `spec:`,
    `  replicas: ${(i % 3) + 1}`,
    `  selector:`,
    `    matchLabels:`,
    `      app: service-${i}`,
    `  template:`,
    `    spec:`,
    `      containers:`,
    `        - name: service-${i}`,
    `          image: registry/service-${i}:latest`,
    `          ports:`,
    `            - containerPort: ${3000 + i}`,
    `          resources:`,
    `            limits:`,
    `              memory: "${128 + (i % 4) * 64}Mi"`,
    `              cpu: "${250 + (i % 3) * 250}m"`,
  ].join('\n'),
};

type FileCategory = keyof typeof TEMPLATES;
const CATEGORIES: Array<{ cat: FileCategory; ext: string; weight: number }> = [
  { cat: 'typescript', ext: '.ts',   weight: 30 },
  { cat: 'python',     ext: '.py',   weight: 15 },
  { cat: 'markdown',   ext: '.md',   weight: 15 },
  { cat: 'rust',       ext: '.rs',   weight: 10 },
  { cat: 'json',       ext: '.json', weight: 10 },
  { cat: 'sql',        ext: '.sql',  weight: 10 },
  { cat: 'yaml',       ext: '.yaml', weight: 10 },
];

const DIR_NAMES = [
  'src', 'src/auth', 'src/api', 'src/models', 'src/services',
  'src/utils', 'src/middleware', 'lib', 'lib/core', 'lib/helpers',
  'docs', 'docs/api', 'docs/guides', 'config', 'migrations',
  'tests', 'tests/unit', 'tests/integration', 'scripts', 'infra',
];

async function generateCorpus(): Promise<string[]> {
  console.log(`Generating ${CORPUS_SIZE} files in ${TEST_DIR}...`);

  // Create directories
  for (const dir of DIR_NAMES) {
    await mkdir(join(TEST_DIR, dir), { recursive: true });
  }

  // Build weighted category list
  const weighted: FileCategory[] = [];
  for (const { cat, weight } of CATEGORIES) {
    for (let w = 0; w < weight; w++) weighted.push(cat);
  }

  const paths: string[] = [];
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const cat = weighted[i % weighted.length];
    const ext = CATEGORIES.find(c => c.cat === cat)!.ext;
    const dir = DIR_NAMES[i % DIR_NAMES.length];
    const name = `${cat}-${i}${ext}`;
    const filePath = join(TEST_DIR, dir, name);
    const content = TEMPLATES[cat](i);
    await writeFile(filePath, content, 'utf-8');
    paths.push(filePath);
  }

  console.log(`  Created ${paths.length} files across ${DIR_NAMES.length} directories`);
  return paths;
}

// ── Metrics ────────────────────────────────────────────────

interface Metrics {
  totalFiles: number;
  indexingTimeMs: number;
  filesPerSecond: number;
  avgEmbeddingMs: number;
  searchQueries: Array<{ query: string; results: number; latencyMs: number }>;
  avgSearchMs: number;
  p99SearchMs: number;
  memoryMB: { rss: number; heapUsed: number; heapTotal: number };
  vectorCount: number;
  graphStats: { nodes: number; edges: number };
  dbSizeBytes: number;
}

function formatMetrics(m: Metrics): string {
  const lines = [
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║          RuVector OS — Stress Test Results               ║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║                                                          ║`,
    `║  INDEXING                                                 ║`,
    `║  ────────                                                 ║`,
    `║  Files indexed:     ${String(m.totalFiles).padStart(6)}                            ║`,
    `║  Total time:        ${String((m.indexingTimeMs / 1000).toFixed(1) + 's').padStart(6)}                            ║`,
    `║  Throughput:        ${String(m.filesPerSecond.toFixed(1)).padStart(6)} files/sec                   ║`,
    `║  Avg embedding:     ${String(m.avgEmbeddingMs.toFixed(1) + 'ms').padStart(8)}                          ║`,
    `║                                                          ║`,
    `║  SEARCH (${m.searchQueries.length} queries)                                      ║`,
    `║  ──────                                                   ║`,
    `║  Avg latency:       ${String(m.avgSearchMs.toFixed(1) + 'ms').padStart(8)}                          ║`,
    `║  P99 latency:       ${String(m.p99SearchMs.toFixed(1) + 'ms').padStart(8)}                          ║`,
    `║                                                          ║`,
    `║  STORAGE                                                  ║`,
    `║  ───────                                                  ║`,
    `║  Vectors:           ${String(m.vectorCount).padStart(6)}                            ║`,
    `║  Graph nodes:       ${String(m.graphStats.nodes).padStart(6)}                            ║`,
    `║  Graph edges:       ${String(m.graphStats.edges).padStart(6)}                            ║`,
    `║  DB size:           ${String((m.dbSizeBytes / 1024 / 1024).toFixed(1) + 'MB').padStart(8)}                          ║`,
    `║                                                          ║`,
    `║  MEMORY                                                   ║`,
    `║  ──────                                                   ║`,
    `║  RSS:               ${String(m.memoryMB.rss.toFixed(0) + 'MB').padStart(8)}                          ║`,
    `║  Heap used:         ${String(m.memoryMB.heapUsed.toFixed(0) + 'MB').padStart(8)}                          ║`,
    `║  Heap total:        ${String(m.memoryMB.heapTotal.toFixed(0) + 'MB').padStart(8)}                          ║`,
    `║                                                          ║`,
    `║  SEARCH DETAILS                                           ║`,
    `║  ──────────────                                           ║`,
  ];

  for (const sq of m.searchQueries) {
    const q = sq.query.length > 30 ? sq.query.slice(0, 27) + '...' : sq.query;
    lines.push(
      `║  "${q.padEnd(30)}" → ${String(sq.results).padStart(2)} results, ${String(sq.latencyMs.toFixed(1) + 'ms').padStart(8)} ║`
    );
  }

  lines.push(
    `║                                                          ║`,
    `╚══════════════════════════════════════════════════════════╝`,
  );
  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('RuVector OS — Stress Test');
  console.log('========================\n');

  // 1. Generate corpus
  const paths = await generateCorpus();

  // 2. Initialize subsystems in-process (no daemon, no PID file)
  console.log('\nInitializing subsystems...');

  const { OnnxEmbedder } = await import('../src/embeddings/onnx-embedder.js');
  const { VectorStore } = await import('../src/engine/vector-store.js');
  const { MetadataDb } = await import('../src/engine/metadata-db.js');
  const { KnowledgeGraph } = await import('../src/engine/knowledge-graph.js');
  const { Indexer } = await import('../src/engine/indexer.js');
  const { SearchEngine } = await import('../src/engine/search.js');

  const embedder = new OnnxEmbedder();
  if (!(await embedder.isModelDownloaded())) {
    console.log('Downloading ONNX model (first run)...');
    await embedder.downloadModel((msg: string) => process.stdout.write(`  ${msg}\r`));
    console.log('');
  }

  const vectorStore = new VectorStore(384);
  await vectorStore.init();

  const metadataDb = new MetadataDb(); // Uses default DB_PATH
  await metadataDb.init();

  const graph = new KnowledgeGraph();
  await graph.init();

  const indexer = new Indexer(vectorStore, metadataDb, graph, embedder);
  const searchEngine = new SearchEngine(vectorStore, metadataDb, graph, embedder);

  console.log('  Subsystems initialized.\n');

  // 3. Index all files
  console.log(`Indexing ${paths.length} files...`);
  let indexed = 0;
  let lastReport = performance.now();

  indexer.on('indexed', () => {
    indexed++;
    const now = performance.now();
    if (now - lastReport > 2000) {
      const pct = ((indexed / paths.length) * 100).toFixed(0);
      process.stdout.write(`  ${indexed}/${paths.length} (${pct}%)\r`);
      lastReport = now;
    }
  });
  indexer.on('updated', () => indexed++);

  const indexStart = performance.now();
  for (const path of paths) {
    indexer.enqueue({ type: 'add', path });
  }
  await indexer.flush();
  const indexEnd = performance.now();
  const indexTimeMs = indexEnd - indexStart;

  console.log(`  ${indexed}/${paths.length} indexed in ${(indexTimeMs / 1000).toFixed(1)}s`);

  const indexerStats = indexer.getStats();

  // 4. Run search queries
  console.log('\nRunning search queries...');
  const queries = [
    'authentication service with JWT tokens',
    'database migration schema creation',
    'API endpoint handling request validation',
    'concurrent data structure thread safety',
    'deployment configuration kubernetes pods',
    'data processing pipeline transformation',
    'error handling and logging middleware',
    'cache invalidation strategy redis',
    'unit testing integration tests',
    'performance optimization query latency',
    'python data analysis pandas numpy',
    'rust concurrent hashmap implementation',
    'typescript dependency injection service',
    'SQL index creation and optimization',
    'YAML deployment replicas resources',
    'connection pooling max connections',
    'monitoring observability structured logging',
    'security authentication authorization',
    'configuration management environment variables',
    'circuit breaker pattern external dependencies',
  ];

  const searchResults: Array<{ query: string; results: number; latencyMs: number }> = [];
  for (const q of queries) {
    const start = performance.now();
    const results = await searchEngine.search({ query: q, limit: 10, threshold: 0.3 });
    const latency = performance.now() - start;
    searchResults.push({ query: q, results: results.length, latencyMs: latency });
  }

  const latencies = searchResults.map(r => r.latencyMs).sort((a, b) => a - b);
  const avgSearchMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p99SearchMs = latencies[Math.floor(latencies.length * 0.99)] ?? latencies[latencies.length - 1];

  // 5. Collect metrics
  const mem = process.memoryUsage();
  const graphStats = await graph.getStats();
  const dbStats = metadataDb.getStats();
  const vectorCount = await vectorStore.count();

  const metrics: Metrics = {
    totalFiles: indexed,
    indexingTimeMs: indexTimeMs,
    filesPerSecond: indexed / (indexTimeMs / 1000),
    avgEmbeddingMs: indexerStats.avgEmbeddingTime,
    searchQueries: searchResults,
    avgSearchMs,
    p99SearchMs,
    memoryMB: {
      rss: mem.rss / 1024 / 1024,
      heapUsed: mem.heapUsed / 1024 / 1024,
      heapTotal: mem.heapTotal / 1024 / 1024,
    },
    vectorCount,
    graphStats,
    dbSizeBytes: dbStats.dbSize,
  };

  console.log(formatMetrics(metrics));

  // 6. Cleanup
  console.log('\nCleaning up test files...');
  metadataDb.close();
  embedder.unload();
  await rm(TEST_DIR, { recursive: true, force: true });
  console.log('Done.\n');
}

main().catch((err) => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
