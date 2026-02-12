/** Core types for RuVector OS */

export interface RuvectorConfig {
  /** Directories being watched */
  watchDirs: string[];
  /** Data storage directory */
  dataDir: string;
  /** Dashboard port */
  dashboardPort: number;
  /** MCP server port */
  mcpPort: number;
  /** ONNX model path */
  modelPath: string;
  /** Vector dimensions (384 for all-MiniLM-L6-v2) */
  dimensions: number;
  /** Max elements in HNSW index */
  maxElements: number;
  /** File extensions to index */
  indexExtensions: string[];
  /** Directories to ignore */
  ignoreDirs: string[];
  /** Max file size to index (bytes) */
  maxFileSize: number;
  /** Idle timeout before unloading ONNX model (ms) */
  modelIdleTimeout: number;
  /** Whether clipboard monitoring is enabled */
  clipboardEnabled: boolean;
  /** Whether the daemon is running */
  running: boolean;
}

export interface IndexedFile {
  /** Unique ID (content hash or path hash) */
  id: string;
  /** Absolute file path */
  path: string;
  /** File name */
  name: string;
  /** File extension */
  extension: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modifiedAt: number;
  /** When this file was first indexed */
  indexedAt: number;
  /** When the embedding was last computed */
  embeddedAt: number;
  /** Extracted text content (truncated) */
  contentPreview: string;
  /** Content hash for change detection */
  contentHash: string;
}

export interface SearchResult {
  /** File info */
  file: IndexedFile;
  /** Similarity score (0-1) */
  score: number;
  /** Matched content snippet */
  snippet: string;
  /** Related files from knowledge graph */
  relatedFiles?: IndexedFile[];
  /** Auto-assigned topic tags (Tier 3) */
  tags?: string[];
}

export interface SearchQuery {
  /** Natural language query */
  query: string;
  /** Max results */
  limit: number;
  /** Minimum similarity threshold */
  threshold: number;
  /** Filter by file extensions */
  extensions?: string[];
  /** Filter by directory */
  directory?: string;
}

export interface GraphNode {
  id: string;
  type: 'file' | 'concept' | 'tag';
  label: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'contains' | 'relates_to' | 'similar_to' | 'references';
  weight: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime: number;
  indexedFiles: number;
  totalVectors: number;
  graphNodes: number;
  graphEdges: number;
  watchedDirs: string[];
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  storageSize: number;
  lastActivity: number;
}

export interface WatcherEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  stats?: {
    size: number;
    mtime: Date;
  };
}

export interface LearningMetrics {
  totalSearches: number;
  totalClicks: number;
  clickThroughRate: number;
  topFilesByImportance: Array<{ fileId: string; path: string; score: number }>;
  lastSweepTime: number;
  sweepFileCount: number;
  gnnActive: boolean;
}

export interface SearchResultWithTracking extends SearchResult {
  searchId: number;
}

export const DEFAULT_CONFIG: RuvectorConfig = {
  watchDirs: [],
  dataDir: '',  // Set at runtime to ~/Library/Application Support/ruvector-os/
  dashboardPort: 3333,
  mcpPort: 3334,
  modelPath: '',  // Set at runtime
  dimensions: 384,
  maxElements: 100000,
  indexExtensions: [
    '.txt', '.md', '.markdown',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
    '.rb', '.php', '.swift', '.kt', '.scala',
    '.html', '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml', '.xml',
    '.sh', '.bash', '.zsh', '.fish',
    '.sql', '.graphql',
    '.r', '.R', '.jl',
    '.tex', '.bib',
    '.csv', '.tsv',
    '.pdf',
    '.env', '.gitignore', '.dockerignore',
    '.prisma', '.proto',
  ],
  ignoreDirs: [
    'node_modules', '.git', '.svn', '.hg',
    '__pycache__', '.pytest_cache', '.mypy_cache',
    'dist', 'build', 'out', '.next', '.nuxt',
    '.cache', '.parcel-cache',
    'target',  // Rust
    'vendor',  // Go, PHP
    '.idea', '.vscode',
    'coverage', '.nyc_output',
    'venv', '.venv', 'env',
  ],
  maxFileSize: 1024 * 1024,  // 1MB
  modelIdleTimeout: 5 * 60 * 1000,  // 5 minutes
  clipboardEnabled: false,
  running: false,
};
