import { InferenceSession, Tensor } from 'onnxruntime-node';
import { readFile, writeFile, access } from 'fs/promises';
import { MODEL_PATH, TOKENIZER_PATH, MODEL_DIR } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';

const MODEL_URL = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx';
const TOKENIZER_URL = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json';

interface TokenizerConfig {
  model: {
    vocab: Record<string, number>;
  };
  added_tokens: Array<{ id: number; content: string }>;
}

/**
 * ONNX-based text embedder using all-MiniLM-L6-v2.
 * Produces 384-dimensional embeddings locally with no API calls.
 * Supports lazy loading and idle unloading to conserve memory.
 */
export class OnnxEmbedder {
  private session: InferenceSession | null = null;
  private vocab: Map<string, number> = new Map();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeout: number;
  private ready = false;
  private loading = false;

  /** Number of dimensions in output embeddings */
  readonly dimensions = 384;

  constructor(idleTimeout = 5 * 60 * 1000) {
    this.idleTimeout = idleTimeout;
  }

  /** Check if ONNX model is downloaded */
  async isModelDownloaded(): Promise<boolean> {
    try {
      await access(MODEL_PATH);
      await access(TOKENIZER_PATH);
      return true;
    } catch {
      return false;
    }
  }

  /** Download model files if not present */
  async downloadModel(onProgress?: (msg: string) => void): Promise<void> {
    await ensureDir(MODEL_DIR);

    if (await this.isModelDownloaded()) {
      onProgress?.('Model already downloaded');
      return;
    }

    onProgress?.('Downloading ONNX model (all-MiniLM-L6-v2, ~23MB)...');
    const modelResponse = await fetch(MODEL_URL);
    if (!modelResponse.ok) throw new Error(`Failed to download model: ${modelResponse.statusText}`);
    const modelBuffer = Buffer.from(await modelResponse.arrayBuffer());
    await writeFile(MODEL_PATH, modelBuffer);
    onProgress?.(`Model saved (${(modelBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

    onProgress?.('Downloading tokenizer...');
    const tokenizerResponse = await fetch(TOKENIZER_URL);
    if (!tokenizerResponse.ok) throw new Error(`Failed to download tokenizer: ${tokenizerResponse.statusText}`);
    const tokenizerBuffer = Buffer.from(await tokenizerResponse.arrayBuffer());
    await writeFile(TOKENIZER_PATH, tokenizerBuffer);
    onProgress?.('Tokenizer saved');
  }

  /** Load model into memory (lazy — called automatically on first embed) */
  async load(): Promise<void> {
    if (this.ready || this.loading) return;
    this.loading = true;

    try {
      // Load tokenizer vocabulary
      const tokenizerData = JSON.parse(
        await readFile(TOKENIZER_PATH, 'utf-8')
      ) as TokenizerConfig;
      this.vocab = new Map(Object.entries(tokenizerData.model.vocab));

      // Load ONNX session
      this.session = await InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      this.ready = true;
      this.resetIdleTimer();
    } finally {
      this.loading = false;
    }
  }

  /** Unload model from memory to save RAM */
  unload(): void {
    this.session = null;
    this.vocab.clear();
    this.ready = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Embed a text string into a 384-dim vector */
  async embed(text: string): Promise<Float32Array> {
    if (!this.ready) await this.load();
    this.resetIdleTimer();

    const tokens = this.tokenize(text);
    const inputIds = new BigInt64Array(tokens.map(t => BigInt(t)));
    const attentionMask = new BigInt64Array(tokens.length).fill(1n);
    const tokenTypeIds = new BigInt64Array(tokens.length).fill(0n);

    const feeds = {
      input_ids: new Tensor('int64', inputIds, [1, tokens.length]),
      attention_mask: new Tensor('int64', attentionMask, [1, tokens.length]),
      token_type_ids: new Tensor('int64', tokenTypeIds, [1, tokens.length]),
    };

    const results = await this.session!.run(feeds);

    // Get the last hidden state and mean pool it
    const output = results['last_hidden_state'] ?? results['output_0'];
    if (!output) {
      throw new Error('Unexpected model output: ' + Object.keys(results).join(', '));
    }

    return this.meanPool(output.data as Float32Array, tokens.length, this.dimensions);
  }

  /** Embed multiple texts (batched for efficiency) */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // For now, sequential. Could be optimized with batched inference.
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /** Simple WordPiece-like tokenization */
  private tokenize(text: string): number[] {
    const CLS = this.vocab.get('[CLS]') ?? 101;
    const SEP = this.vocab.get('[SEP]') ?? 102;
    const UNK = this.vocab.get('[UNK]') ?? 100;
    const MAX_LENGTH = 512;

    // Lowercase and split into words
    const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    const tokens: number[] = [CLS];

    for (const word of words) {
      if (tokens.length >= MAX_LENGTH - 1) break;

      // Try full word first
      const fullId = this.vocab.get(word);
      if (fullId !== undefined) {
        tokens.push(fullId);
        continue;
      }

      // WordPiece tokenization
      let start = 0;
      let matched = false;
      while (start < word.length && tokens.length < MAX_LENGTH - 1) {
        let end = word.length;
        let found = false;
        while (start < end) {
          const substr = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
          const id = this.vocab.get(substr);
          if (id !== undefined) {
            tokens.push(id);
            start = end;
            found = true;
            matched = true;
            break;
          }
          end--;
        }
        if (!found) {
          tokens.push(UNK);
          start++;
        }
      }
    }

    tokens.push(SEP);
    return tokens;
  }

  /** Mean pooling over token embeddings */
  private meanPool(data: Float32Array, seqLen: number, hiddenSize: number): Float32Array {
    const result = new Float32Array(hiddenSize);
    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < hiddenSize; j++) {
        result[j] += data[i * hiddenSize + j];
      }
    }
    for (let j = 0; j < hiddenSize; j++) {
      result[j] /= seqLen;
    }
    // L2 normalize
    let norm = 0;
    for (let j = 0; j < hiddenSize; j++) {
      norm += result[j] * result[j];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let j = 0; j < hiddenSize; j++) {
        result[j] /= norm;
      }
    }
    return result;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.unload();
    }, this.idleTimeout);
  }
}
