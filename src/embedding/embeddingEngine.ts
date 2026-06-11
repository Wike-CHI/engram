// Engram — Embedding Engine
// Zero-config text embedding via OpenAI-compatible API.
// No external services, no ChromaDB, no Docker. Just an API key.
// Ported from holo-desktop embeddingEngine.ts — Electron deps removed.

import type { EngramLogger } from "../types/memory";

/** Configuration for the embedding engine */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

const defaultLogger: EngramLogger = {
  info: (msg) => console.log(`[engram:embedding] ${msg}`),
  warn: (msg) => console.warn(`[engram:embedding] ${msg}`),
  error: (msg) => console.error(`[engram:embedding] ${msg}`),
  debug: (msg) => { /* noop by default */ },
};

/**
 * EmbeddingEngine — generates embeddings using any OpenAI-compatible API.
 * Configuration is injected at construction time (no global state).
 */
export class EmbeddingEngine {
  private config: EmbeddingConfig;
  private logger: EngramLogger;

  constructor(
    config: EmbeddingConfig,
    logger?: EngramLogger,
  ) {
    this.config = config;
    this.logger = logger ?? defaultLogger;
  }

  /** Generate embedding for a single text string */
  async embed(text: string): Promise<number[] | null> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");

    try {
      const resp = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model ?? DEFAULT_MODEL,
          input: text.slice(0, 8000),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        this.logger.warn(`embedding API returned ${resp.status}`);
        return null;
      }

      const data = (await resp.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };

      return data.data?.[0]?.embedding ?? null;
    } catch (err) {
      this.logger.warn(`embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Generate embeddings for a batch of texts */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");

    try {
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const chunk = texts.slice(i, i + BATCH_SIZE);
        const resp = await fetch(`${baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model ?? DEFAULT_MODEL,
            input: chunk.map((t) => t.slice(0, 8000)),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) break;

        const data = (await resp.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };

        if (data.data) {
          for (const item of data.data) {
            const idx = (item.index ?? 0) + i;
            if (item.embedding) results[idx] = item.embedding;
          }
        }
      }
    } catch (err) {
      this.logger.warn(`batch embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return results;
  }

  /** Check if the engine is available (config is valid) */
  isAvailable(): boolean {
    return !!(this.config.baseUrl && this.config.apiKey);
  }
}

// ══════════════════════════════════════════════════════════════
// Factory — create from a simpler config, or from environment
// ══════════════════════════════════════════════════════════════

/**
 * Create an EmbeddingEngine from environment variables:
 * - ENGRAM_EMBEDDING_BASE_URL  (default: https://api.openai.com/v1)
 * - ENGRAM_EMBEDDING_API_KEY   (default: process.env.OPENAI_API_KEY)
 * - ENGRAM_EMBEDDING_MODEL     (default: text-embedding-3-small)
 */
export function createEmbeddingEngineFromEnv(
  logger?: EngramLogger,
): EmbeddingEngine | null {
  const baseUrl =
    process.env.ENGRAM_EMBEDDING_BASE_URL ??
    "https://api.openai.com/v1";
  const apiKey =
    process.env.ENGRAM_EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY;

  if (!apiKey) return null;

  return new EmbeddingEngine(
    {
      baseUrl,
      apiKey,
      model: process.env.ENGRAM_EMBEDDING_MODEL,
    },
    logger,
  );
}
