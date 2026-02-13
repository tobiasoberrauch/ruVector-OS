import { describe, it, expect } from 'vitest';
import { Chunker } from './chunker.js';

describe('Chunker', () => {
  const chunker = new Chunker();

  describe('small file passthrough', () => {
    it('returns a single chunk for small files', () => {
      const content = 'const x = 1;\nconst y = 2;';
      const chunks = chunker.chunk(content, '.ts');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(content);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(2);
    });

    it('returns empty array for empty content', () => {
      expect(chunker.chunk('', '.ts')).toHaveLength(0);
      expect(chunker.chunk('   ', '.ts')).toHaveLength(0);
    });
  });

  describe('code chunking', () => {
    it('splits TypeScript class and functions into separate chunks', () => {
      const content = `import { something } from 'somewhere';
// This is a large file with many functions and classes.
// ${'padding '.repeat(100)}

export class AuthService {
  private token: string;
  // ${'comment '.repeat(50)}

  constructor() {
    this.token = '';
  }

  async login(user: string, pass: string) {
    // ${'validate '.repeat(40)}
    return this.validate(user, pass);
  }

  private validate(user: string, pass: string) {
    // ${'check '.repeat(40)}
    return true;
  }
}

export function createService() {
  // ${'factory '.repeat(40)}
  return new AuthService();
}

export const helper = () => {
  // ${'helper '.repeat(40)}
  return 42;
}
`;

      const chunks = chunker.chunk(content, '.ts');
      expect(chunks.length).toBeGreaterThan(1);

      // Chunks should have sequential indices
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }

      // At least one chunk should have a label
      const labels = chunks.map(c => c.label).filter(Boolean);
      expect(labels.length).toBeGreaterThan(0);
    });

    it('splits Python def and class definitions', () => {
      const content = `import os
import sys
# ${'padding '.repeat(100)}

class DataProcessor:
    # ${'docstring '.repeat(50)}
    def __init__(self):
        self.data = []

    def process(self, item):
        # ${'process '.repeat(40)}
        return item * 2

    def transform(self, items):
        # ${'transform '.repeat(40)}
        return [self.process(i) for i in items]

def main():
    # ${'main '.repeat(40)}
    processor = DataProcessor()
    result = processor.transform([1, 2, 3])
    print(result)

class AnotherProcessor:
    def run(self):
        # ${'run '.repeat(40)}
        pass
`;

      const chunks = chunker.chunk(content, '.py');
      expect(chunks.length).toBeGreaterThan(1);

      // Should find 'DataProcessor' or 'main' labels
      const labels = chunks.map(c => c.label).filter(Boolean);
      expect(labels.length).toBeGreaterThan(0);
    });

    it('splits Rust functions and structs', () => {
      const content = `use std::collections::HashMap;
// ${'padding '.repeat(100)}

pub struct Config {
    pub name: String,
    pub values: HashMap<String, String>,
    // ${'field '.repeat(50)}
}

impl Config {
    pub fn new(name: &str) -> Self {
        // ${'init '.repeat(40)}
        Config {
            name: name.to_string(),
            values: HashMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        // ${'get '.repeat(40)}
        self.values.get(key)
    }
}

pub fn load_config(path: &str) -> Config {
    // ${'load '.repeat(40)}
    Config::new("default")
}

fn helper() -> bool {
    // ${'helper '.repeat(40)}
    true
}
`;

      const chunks = chunker.chunk(content, '.rs');
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits Go functions', () => {
      const content = `package main

import "fmt"
// ${'padding '.repeat(200)}

func main() {
    // ${'main '.repeat(100)}
    fmt.Println("hello")
    result := process("data")
    fmt.Println(result)
}

func process(data string) string {
    // ${'process '.repeat(100)}
    return data + " processed"
}

func handleRequest(req Request) Response {
    // ${'handle '.repeat(100)}
    return Response{Status: 200}
}
`;

      const chunks = chunker.chunk(content, '.go');
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('extracts function name as label', () => {
      const content = `// header
// ${'padding '.repeat(200)}
const x = 1;

export function authenticate(user, pass) {
  // ${'auth '.repeat(150)}
  return true;
}
`;

      const chunks = chunker.chunk(content, '.ts');
      const authChunk = chunks.find(c => c.label === 'authenticate');
      expect(authChunk).toBeDefined();
    });

    it('extracts class name as label', () => {
      const content = `// header
// ${'padding '.repeat(200)}
const x = 1;

export class UserService {
  // ${'service '.repeat(150)}
  constructor() {}
  getUser() { return null; }
}
`;

      const chunks = chunker.chunk(content, '.ts');
      const classChunk = chunks.find(c => c.label === 'UserService');
      expect(classChunk).toBeDefined();
    });

    it('merges small chunks with previous', () => {
      // Create content where some "functions" are very short
      const content = `// big header block
// ${'comment '.repeat(100)}

export function bigFunction() {
  // ${'body '.repeat(80)}
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}

const x = 1
`;

      const chunks = chunker.chunk(content, '.ts');
      // No chunk should be less than MIN_CHUNK_SIZE (100)
      for (const chunk of chunks) {
        // Allow last chunk to be smaller
        if (chunk.index < chunks.length - 1) {
          expect(chunk.text.length).toBeGreaterThanOrEqual(50);
        }
      }
    });
  });

  describe('markdown chunking', () => {
    it('splits at heading boundaries', () => {
      const content = `# Introduction

This is the introduction section with a lot of text to make sure
we exceed the small file threshold of 2000 characters.
${'Padding text for the introduction section. '.repeat(30)}

## Getting Started

Here are the steps to get started with the project.
${'Detailed instructions for setting up the environment. '.repeat(30)}

## Configuration

Configuration details go here.
${'Config options and their descriptions go here. '.repeat(30)}

### Advanced Settings

Advanced configuration goes here.
${'Expert-level settings documentation. '.repeat(20)}
`;

      const chunks = chunker.chunk(content, '.md');
      expect(chunks.length).toBeGreaterThan(1);

      // Should use headings as labels
      const labels = chunks.map(c => c.label).filter(Boolean);
      expect(labels).toContain('Introduction');
      expect(labels).toContain('Getting Started');
    });

    it('keeps content under headings together', () => {
      const content = `# Main Title

${'Content under main title with lots of padding text. '.repeat(30)}

## Section One

${'Content under section one with even more padding. '.repeat(30)}

## Section Two

${'Content under section two with additional padding. '.repeat(30)}
`;

      const chunks = chunker.chunk(content, '.md');
      // Each chunk should start with its heading (except possibly the first)
      for (const chunk of chunks.slice(1)) {
        if (chunk.label) {
          expect(chunk.text).toMatch(/^#{1,3}\s+/);
        }
      }
    });
  });

  describe('sliding window fallback', () => {
    it('uses sliding window for unsupported extensions', () => {
      const content = 'x'.repeat(5000);
      const chunks = chunker.chunk(content, '.xyz');
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('creates overlapping windows', () => {
      // Create content large enough for multiple windows
      const content = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(20)}`).join('\n');
      const chunks = chunker.chunk(content, '.log');
      expect(chunks.length).toBeGreaterThan(1);

      // Check overlap: last part of chunk N should appear at start of chunk N+1
      if (chunks.length >= 2) {
        const endOfFirst = chunks[0].text.slice(-100);
        expect(chunks[1].text).toContain(endOfFirst.slice(0, 50));
      }
    });

    it('covers all content', () => {
      const content = 'a'.repeat(4500);
      const chunks = chunker.chunk(content, '.dat');
      // All content should be covered
      const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
      // With overlap, total chars should be >= original
      expect(totalChars).toBeGreaterThanOrEqual(content.length);
    });
  });

  describe('chunk indices', () => {
    it('assigns sequential zero-based indices', () => {
      const content = `# ${'padding '.repeat(100)}\ndef func_a():\n    # ${'a '.repeat(80)}\n    pass\n\ndef func_b():\n    # ${'b '.repeat(80)}\n    pass\n\ndef func_c():\n    # ${'c '.repeat(80)}\n    pass\n`;
      const chunks = chunker.chunk(content, '.py');
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });

  describe('line numbers', () => {
    it('tracks start and end lines for code chunks', () => {
      const content = `import os\n# ${'padding '.repeat(100)}\n\ndef first():\n    # ${'first '.repeat(80)}\n    pass\n\ndef second():\n    # ${'second '.repeat(80)}\n    pass\n`;
      const chunks = chunker.chunk(content, '.py');
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    });

    it('tracks start and end lines for sliding window', () => {
      const content = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
      const chunks = chunker.chunk(content, '.log');
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    });
  });

  describe('extension normalization', () => {
    it('handles extensions with leading dot', () => {
      const content = 'x'.repeat(3000);
      const chunks1 = chunker.chunk(content, '.py');
      const chunks2 = chunker.chunk(content, 'py');
      // Both should use the same strategy
      expect(chunks1.length).toBe(chunks2.length);
    });
  });
});
