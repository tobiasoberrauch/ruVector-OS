import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { contentHash, fileId, shouldIndex, formatBytes, formatDuration, extractContent } from './utils.js';
import { writeFile, unlink, mkdir, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('contentHash', () => {
  it('returns a 16-char hex string', () => {
    const hash = contentHash('hello world');
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('returns same hash for same input', () => {
    expect(contentHash('test')).toBe(contentHash('test'));
  });

  it('returns different hashes for different input', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('fileId', () => {
  it('returns a 16-char hex string', () => {
    const id = fileId('/path/to/file.ts');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic', () => {
    expect(fileId('/same/path')).toBe(fileId('/same/path'));
  });

  it('is different for different paths', () => {
    expect(fileId('/path/a')).not.toBe(fileId('/path/b'));
  });
});

describe('shouldIndex', () => {
  const exts = ['.ts', '.js', '.md', '.py'];

  it('returns true for matching extensions', () => {
    expect(shouldIndex('file.ts', exts)).toBe(true);
    expect(shouldIndex('file.md', exts)).toBe(true);
  });

  it('returns false for non-matching extensions', () => {
    expect(shouldIndex('file.exe', exts)).toBe(false);
    expect(shouldIndex('file.zip', exts)).toBe(false);
  });

  it('handles extensionless special files', () => {
    expect(shouldIndex('Makefile', exts)).toBe(true);
    expect(shouldIndex('Dockerfile', exts)).toBe(true);
    expect(shouldIndex('LICENSE', exts)).toBe(true);
  });

  it('returns false for unknown extensionless files', () => {
    expect(shouldIndex('randomfile', exts)).toBe(false);
  });

  it('is case-insensitive for extensions', () => {
    // shouldIndex lowercases the extension before comparing
    expect(shouldIndex('file.TS', ['.ts'])).toBe(true);
    expect(shouldIndex('FILE.ts', ['.ts'])).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('formats GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5.0s');
  });

  it('formats minutes', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats hours', () => {
    expect(formatDuration(7200000)).toBe('2h 0m');
  });
});

describe('extractContent', () => {
  const testDir = join(tmpdir(), 'ruvector-test-' + Date.now());

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      const { readdirSync, unlinkSync, rmdirSync } = await import('fs');
      for (const f of readdirSync(testDir)) unlinkSync(join(testDir, f));
      rmdirSync(testDir);
    } catch {}
  });

  it('reads text file content', async () => {
    const path = join(testDir, 'test.txt');
    await writeFile(path, 'Hello, world!');
    const content = await extractContent(path);
    expect(content).toBe('Hello, world!');
  });

  it('truncates long content to 10000 chars', async () => {
    const path = join(testDir, 'long.txt');
    await writeFile(path, 'x'.repeat(20000));
    const content = await extractContent(path);
    expect(content.length).toBe(10000);
  });

  it('strips control characters', async () => {
    const path = join(testDir, 'ctrl.txt');
    await writeFile(path, 'hello\x00\x01world');
    const content = await extractContent(path);
    expect(content).toBe('helloworld');
  });

  it('returns empty string for non-existent files', async () => {
    const content = await extractContent('/nonexistent/file.txt');
    expect(content).toBe('');
  });
});
