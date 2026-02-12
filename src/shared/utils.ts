import { createHash } from 'crypto';
import { readFile, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, basename } from 'path';
import type { IndexedFile } from './types.js';

/** Compute SHA-256 hash of content */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Compute a stable ID from file path */
export function fileId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/** Ensure a directory exists */
export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/** Extract text content from a file */
export async function extractContent(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    // Truncate to reasonable size for embedding
    return content.slice(0, 10000);
  } catch {
    return '';
  }
}

/** Create an IndexedFile record from a path */
export async function createFileRecord(filePath: string, content: string): Promise<IndexedFile> {
  const stats = await stat(filePath);
  const now = Date.now();
  return {
    id: fileId(filePath),
    path: filePath,
    name: basename(filePath),
    extension: extname(filePath),
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    indexedAt: now,
    embeddedAt: now,
    contentPreview: content.slice(0, 500),
    contentHash: contentHash(content),
  };
}

/** Check if a file extension should be indexed */
export function shouldIndex(filePath: string, extensions: string[]): boolean {
  const ext = extname(filePath).toLowerCase();
  // Also index extensionless files that might be configs (Makefile, Dockerfile, etc)
  if (!ext) {
    const name = basename(filePath);
    const extensionless = [
      'Makefile', 'Dockerfile', 'Containerfile', 'Vagrantfile',
      'Rakefile', 'Gemfile', 'Procfile', 'Brewfile',
      'LICENSE', 'README', 'CHANGELOG', 'CONTRIBUTING',
    ];
    return extensionless.includes(name);
  }
  return extensions.includes(ext);
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Format milliseconds to human-readable duration */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}
