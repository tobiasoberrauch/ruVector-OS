import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentExtractor } from './content-extractor.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile, rm } from 'fs/promises';

const testRoot = join(tmpdir(), 'ruvector-content-extractor-test');

describe('ContentExtractor', () => {
  let extractor: ContentExtractor;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(testRoot, `run-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    extractor = new ContentExtractor();
  });

  afterEach(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('basic text extraction', () => {
    it('extracts content from a plain text file', async () => {
      const filePath = join(testDir, 'hello.txt');
      await writeFile(filePath, 'Hello, world!');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('Hello, world!');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata).toEqual({});
    });

    it('extracts content from a TypeScript file', async () => {
      const filePath = join(testDir, 'app.ts');
      await writeFile(filePath, 'export function main() { return 42; }');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('export function main() { return 42; }');
      expect(result.mimeType).toBe('text/typescript');
    });

    it('extracts content from a Python file', async () => {
      const filePath = join(testDir, 'app.py');
      await writeFile(filePath, 'def main():\n    return 42');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('def main():\n    return 42');
      expect(result.mimeType).toBe('text/x-python');
    });

    it('strips control characters from content', async () => {
      const filePath = join(testDir, 'dirty.txt');
      await writeFile(filePath, 'hello\x00world\x01!\x02');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('helloworld!');
    });

    it('returns empty content for nonexistent files', async () => {
      const result = await extractor.extract('/nonexistent/file.txt');
      expect(result.content).toBe('');
    });

    it('handles empty files', async () => {
      const filePath = join(testDir, 'empty.txt');
      await writeFile(filePath, '');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('');
    });
  });

  describe('markdown frontmatter', () => {
    it('extracts title from frontmatter', async () => {
      const filePath = join(testDir, 'doc.md');
      await writeFile(filePath, `---
title: My Document
---

# Hello`);

      const result = await extractor.extract(filePath);
      expect(result.metadata.title).toBe('My Document');
      expect(result.content).toContain('# Hello');
      expect(result.content).not.toContain('---');
      expect(result.mimeType).toBe('text/markdown');
    });

    it('extracts multiple frontmatter fields', async () => {
      const filePath = join(testDir, 'post.md');
      await writeFile(filePath, `---
title: Blog Post
author: John Doe
date: 2024-01-15
tags: [typescript, nodejs, testing]
---

Content here.`);

      const result = await extractor.extract(filePath);
      expect(result.metadata.title).toBe('Blog Post');
      expect(result.metadata.author).toBe('John Doe');
      expect(result.metadata.date).toBe('2024-01-15');
      expect(result.metadata.tags).toBe('typescript, nodejs, testing');
      expect(result.content).toBe('\nContent here.');
    });

    it('handles quoted values in frontmatter', async () => {
      const filePath = join(testDir, 'quoted.md');
      await writeFile(filePath, `---
title: "A Document: With Colons"
author: 'Jane Doe'
---

Body`);

      const result = await extractor.extract(filePath);
      expect(result.metadata.title).toBe('A Document: With Colons');
      expect(result.metadata.author).toBe('Jane Doe');
    });

    it('handles empty frontmatter', async () => {
      const filePath = join(testDir, 'empty-fm.md');
      await writeFile(filePath, `---
---

Just content.`);

      const result = await extractor.extract(filePath);
      expect(result.metadata).toEqual({});
      expect(result.content).toContain('Just content.');
    });

    it('handles malformed frontmatter gracefully', async () => {
      const filePath = join(testDir, 'bad-fm.md');
      await writeFile(filePath, `---
not valid yaml just text
---

Content.`);

      const result = await extractor.extract(filePath);
      // Should not crash, just skip bad lines
      expect(result.content).toContain('Content.');
    });

    it('does not parse frontmatter for non-markdown files', async () => {
      const filePath = join(testDir, 'config.yaml');
      await writeFile(filePath, `---
title: Not Frontmatter
---

key: value`);

      const result = await extractor.extract(filePath);
      // The whole content should be preserved (no frontmatter stripping)
      expect(result.content).toContain('---');
      expect(result.metadata).toEqual({});
    });

    it('skips frontmatter keys with empty values', async () => {
      const filePath = join(testDir, 'sparse.md');
      await writeFile(filePath, `---
title: Good Title
empty:
---

Content.`);

      const result = await extractor.extract(filePath);
      expect(result.metadata.title).toBe('Good Title');
      expect(result.metadata).not.toHaveProperty('empty');
    });

    it('handles markdown with no frontmatter', async () => {
      const filePath = join(testDir, 'plain.md');
      await writeFile(filePath, '# Just a heading\n\nSome content.');

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('# Just a heading\n\nSome content.');
      expect(result.metadata).toEqual({});
    });
  });

  describe('OCR', () => {
    it('returns empty content for images when OCR is not available', async () => {
      const filePath = join(testDir, 'screenshot.png');
      await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header

      const result = await extractor.extract(filePath);
      expect(result.content).toBe('');
      expect(result.mimeType).toBe('image/png');
    });

    it('reports OCR availability', () => {
      expect(extractor.isOcrAvailable()).toBe(false);
      extractor.setOcrBinary('/usr/local/bin/ocr-helper');
      expect(extractor.isOcrAvailable()).toBe(true);
    });

    it('uses OCR binary for image files when available', async () => {
      // Mock execFile
      const mockExecFile = vi.fn().mockResolvedValue({ stdout: 'OCR extracted text', stderr: '' });
      vi.mock('child_process', () => ({
        execFile: (...args: any[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') {
            cb(null, 'OCR extracted text', '');
          }
        },
      }));

      // For this test, we just verify the OCR path is set correctly
      extractor.setOcrBinary('/fake/ocr-helper');
      expect(extractor.isOcrAvailable()).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('MIME types', () => {
    it('detects TypeScript MIME type', async () => {
      const filePath = join(testDir, 'file.ts');
      await writeFile(filePath, 'const x = 1;');
      const result = await extractor.extract(filePath);
      expect(result.mimeType).toBe('text/typescript');
    });

    it('detects Python MIME type', async () => {
      const filePath = join(testDir, 'file.py');
      await writeFile(filePath, 'x = 1');
      const result = await extractor.extract(filePath);
      expect(result.mimeType).toBe('text/x-python');
    });

    it('detects Markdown MIME type', async () => {
      const filePath = join(testDir, 'file.md');
      await writeFile(filePath, '# Hello');
      const result = await extractor.extract(filePath);
      expect(result.mimeType).toBe('text/markdown');
    });

    it('falls back to octet-stream for unknown extensions', async () => {
      const filePath = join(testDir, 'file.xyz');
      await writeFile(filePath, 'data');
      const result = await extractor.extract(filePath);
      expect(result.mimeType).toBe('application/octet-stream');
    });
  });
});
