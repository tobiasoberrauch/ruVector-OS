import type { Chunk } from '../shared/types.js';

/** Minimum chunk size — chunks smaller than this get merged with the previous */
const MIN_CHUNK_SIZE = 100;
/** Default sliding window chunk size */
const WINDOW_SIZE = 2000;
/** Sliding window overlap */
const WINDOW_OVERLAP = 200;
/** Small file threshold — files below this size stay as a single chunk */
const SMALL_FILE_THRESHOLD = 2000;

/**
 * Regex patterns for code boundary detection by language family.
 * Matches function/class/method declarations at the start of a line.
 */
const CODE_PATTERNS: Record<string, RegExp> = {
  // TypeScript / JavaScript
  ts: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:get|set)\s+\w+\s*\()/m,
  tsx: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:get|set)\s+\w+\s*\()/m,
  js: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/m,
  jsx: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/m,
  mjs: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/m,
  cjs: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/m,
  // Python
  py: /^(?:def|class|async\s+def)\s+\w+/m,
  // Rust
  rs: /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|impl|enum|trait|mod)\s+\w+/m,
  // Go
  go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+/m,
  // Java / Kotlin
  java: /^(?:public|private|protected|static|final|abstract)?\s*(?:class|interface|enum|void|int|String|boolean|long|double|float)\s+\w+/m,
  kt: /^(?:fun|class|interface|object|data\s+class|sealed\s+class)\s+\w+/m,
  // Ruby
  rb: /^(?:def|class|module)\s+\w+/m,
  // PHP
  php: /^(?:public|private|protected|static)?\s*(?:function|class|interface|trait)\s+\w+/m,
  // Swift
  swift: /^(?:func|class|struct|enum|protocol|extension)\s+\w+/m,
  // C/C++
  c: /^(?:static\s+)?(?:void|int|char|float|double|long|unsigned|struct)\s+\w+\s*\(/m,
  cpp: /^(?:class|struct|void|int|auto|template)\s+\w+/m,
  h: /^(?:class|struct|void|int|auto|template)\s+\w+/m,
  hpp: /^(?:class|struct|void|int|auto|template)\s+\w+/m,
  // Scala
  scala: /^(?:def|class|object|trait|val|var)\s+\w+/m,
};

/** Markdown heading pattern */
const MD_HEADING = /^#{1,3}\s+.+$/m;

/** Label extraction patterns — tries to pull a function/class name from a boundary line */
const LABEL_PATTERNS = [
  /(?:function|def|fn|func)\s+(\w+)/,
  /class\s+(\w+)/,
  /(?:struct|enum|trait|impl|interface|object|module|mod)\s+(\w+)/,
  /const\s+(\w+)\s*=/,
];

/**
 * Chunking engine that splits file content into semantically meaningful chunks.
 * Strategy is selected by file extension:
 * - Code files: split at function/class boundaries
 * - Markdown: split at heading boundaries
 * - Everything else: sliding window
 */
export class Chunker {
  /** Chunk content using the appropriate strategy for the given extension */
  chunk(content: string, extension: string): Chunk[] {
    if (!content.trim()) return [];

    // Small files stay as a single chunk
    if (content.length < SMALL_FILE_THRESHOLD) {
      const lines = content.split('\n');
      return [{
        index: 0,
        text: content,
        startLine: 1,
        endLine: lines.length,
        label: undefined,
      }];
    }

    const ext = extension.replace(/^\./, '').toLowerCase();

    // Markdown strategy
    if (ext === 'md' || ext === 'markdown') {
      return this.chunkMarkdown(content);
    }

    // Code strategy (if we have patterns for this language)
    if (ext in CODE_PATTERNS) {
      return this.chunkCode(content, ext);
    }

    // Sliding window fallback
    return this.chunkSlidingWindow(content);
  }

  /** Split code at function/class boundaries */
  private chunkCode(content: string, ext: string): Chunk[] {
    const pattern = CODE_PATTERNS[ext];
    const lines = content.split('\n');
    const boundaries: number[] = [0]; // Always start at line 0

    // Find lines that match a boundary pattern
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (pattern.test(line)) {
        boundaries.push(i);
      }
    }

    // Create chunks from boundaries
    const chunks: Chunk[] = [];
    for (let b = 0; b < boundaries.length; b++) {
      const startIdx = boundaries[b];
      const endIdx = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length;
      const chunkLines = lines.slice(startIdx, endIdx);
      const text = chunkLines.join('\n');

      // Merge small chunks with previous
      if (text.length < MIN_CHUNK_SIZE && chunks.length > 0) {
        const prev = chunks[chunks.length - 1];
        prev.text += '\n' + text;
        prev.endLine = endIdx;
        continue;
      }

      const label = this.extractLabel(chunkLines[0] ?? '');

      chunks.push({
        index: chunks.length,
        text,
        startLine: startIdx + 1,
        endLine: endIdx,
        label: label ?? undefined,
      });
    }

    return this.reindex(chunks);
  }

  /** Split markdown at heading boundaries */
  private chunkMarkdown(content: string): Chunk[] {
    const lines = content.split('\n');
    const boundaries: number[] = [0];

    for (let i = 1; i < lines.length; i++) {
      if (MD_HEADING.test(lines[i])) {
        boundaries.push(i);
      }
    }

    const chunks: Chunk[] = [];
    for (let b = 0; b < boundaries.length; b++) {
      const startIdx = boundaries[b];
      const endIdx = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length;
      const chunkLines = lines.slice(startIdx, endIdx);
      const text = chunkLines.join('\n');

      if (text.length < MIN_CHUNK_SIZE && chunks.length > 0) {
        const prev = chunks[chunks.length - 1];
        prev.text += '\n' + text;
        prev.endLine = endIdx;
        continue;
      }

      // Use heading as label
      const headingMatch = chunkLines[0]?.match(/^#{1,3}\s+(.+)$/);
      const label = headingMatch?.[1]?.trim() ?? undefined;

      chunks.push({
        index: chunks.length,
        text,
        startLine: startIdx + 1,
        endLine: endIdx,
        label,
      });
    }

    return this.reindex(chunks);
  }

  /** Split content using a sliding window with overlap */
  private chunkSlidingWindow(content: string): Chunk[] {
    const chunks: Chunk[] = [];
    let offset = 0;
    let lineOffset = 0;

    while (offset < content.length) {
      const end = Math.min(offset + WINDOW_SIZE, content.length);
      const text = content.slice(offset, end);
      const textLines = text.split('\n');
      const startLine = lineOffset + 1;
      const endLine = lineOffset + textLines.length;

      chunks.push({
        index: chunks.length,
        text,
        startLine,
        endLine,
      });

      if (end >= content.length) break;

      // Advance by window minus overlap
      const advance = WINDOW_SIZE - WINDOW_OVERLAP;
      const advancedText = content.slice(offset, offset + advance);
      lineOffset += advancedText.split('\n').length - 1;
      offset += advance;
    }

    return chunks;
  }

  /** Extract a function/class name label from a boundary line */
  private extractLabel(line: string): string | null {
    for (const pattern of LABEL_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  /** Re-index chunks to ensure sequential indices */
  private reindex(chunks: Chunk[]): Chunk[] {
    return chunks.map((chunk, i) => ({ ...chunk, index: i }));
  }
}
