import { readFile } from 'fs/promises';
import { extname } from 'path';
import { stripControlChars } from '../shared/sanitize.js';
import type { ExtractionResult } from '../shared/types.js';

/** Maximum content size to extract (bytes) */
const MAX_CONTENT_SIZE = 100_000;

/** MIME types by extension */
const MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.js': 'text/javascript', '.jsx': 'text/javascript',
  '.py': 'text/x-python', '.rs': 'text/x-rust', '.go': 'text/x-go',
  '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++',
  '.rb': 'text/x-ruby', '.php': 'text/x-php', '.swift': 'text/x-swift',
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.xml': 'application/xml', '.toml': 'application/toml',
  '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tsv',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.tiff': 'image/tiff', '.bmp': 'image/bmp',
};

/** Image extensions that can be processed by OCR */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.bmp']);

/**
 * Content extraction pipeline.
 * Replaces the bare `extractContent()` function with structured output
 * including metadata extraction (frontmatter, OCR, etc.).
 */
export class ContentExtractor {
  private ocrBinaryPath: string | null = null;

  /** Set the path to the compiled OCR helper binary */
  setOcrBinary(path: string): void {
    this.ocrBinaryPath = path;
  }

  /** Check if OCR is available */
  isOcrAvailable(): boolean {
    return this.ocrBinaryPath !== null;
  }

  /** Extract content and metadata from a file */
  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';

    try {
      // PDF extraction
      if (ext === '.pdf') {
        return this.extractPdf(filePath, mimeType);
      }

      // Image OCR extraction
      if (IMAGE_EXTENSIONS.has(ext)) {
        return this.extractImage(filePath, mimeType);
      }

      // Text-based files
      const raw = await readFile(filePath, 'utf-8');
      const content = stripControlChars(raw.slice(0, MAX_CONTENT_SIZE));

      // Parse frontmatter for markdown files
      if (ext === '.md' || ext === '.markdown') {
        return this.extractMarkdown(content, mimeType);
      }

      return { content, metadata: {}, mimeType };
    } catch {
      return { content: '', metadata: {}, mimeType };
    }
  }

  /** Extract content from a PDF file */
  private async extractPdf(filePath: string, mimeType: string): Promise<ExtractionResult> {
    try {
      const buffer = await readFile(filePath);
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      const content = stripControlChars(result.text.slice(0, MAX_CONTENT_SIZE));
      const metadata: Record<string, string> = {};
      if (result.info?.Title) metadata.title = String(result.info.Title);
      if (result.info?.Author) metadata.author = String(result.info.Author);
      return { content, metadata, mimeType };
    } catch {
      return { content: '', metadata: {}, mimeType };
    }
  }

  /** Extract text from an image using OCR */
  private async extractImage(filePath: string, mimeType: string): Promise<ExtractionResult> {
    if (!this.ocrBinaryPath) {
      return { content: '', metadata: {}, mimeType };
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(this.ocrBinaryPath, [filePath], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });

      const content = stripControlChars(stdout.trim());
      return { content, metadata: { source: 'ocr' }, mimeType };
    } catch {
      return { content: '', metadata: {}, mimeType };
    }
  }

  /** Extract content and frontmatter from a markdown file */
  private extractMarkdown(rawContent: string, mimeType: string): ExtractionResult {
    const metadata: Record<string, string> = {};
    let content = rawContent;

    // Parse YAML frontmatter: ---\n...\n---
    const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?/);
    if (frontmatterMatch) {
      const yamlBlock = frontmatterMatch[1];
      content = rawContent.slice(frontmatterMatch[0].length);

      // Simple YAML key-value parsing (no nested objects, no dependency)
      for (const line of yamlBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Skip empty keys or indented lines (nested YAML)
        if (!key || key.startsWith(' ') || key.startsWith('-')) continue;

        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Handle YAML arrays on single line: [tag1, tag2]
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(s => s.trim()).join(', ');
        }

        if (key && value) {
          metadata[key] = value;
        }
      }
    }

    return { content, metadata, mimeType };
  }
}
