// Engram — JSONL MemoryProvider
// Implements MemoryProvider interface backed by MemoryStore (V1).
// Zero-config: just needs a basePath. No platform dependencies.

import type {
  Memory,
  MemoryInput,
  MemoryPatch,
  MemoryStats,
} from "../types/memory";
import type { MemoryProvider } from "../types/pluginTypes";
import type { EmbeddingFn, Logger } from "../stores/memoryStore";
import { MemoryStore } from "../stores/memoryStore";

/**
 * Options for constructing a JsonlMemoryProvider.
 */
export interface JsonlMemoryProviderOptions {
  /** Directory path for storing memory JSONL files */
  basePath: string;
  /** Optional embedding function for semantic search */
  embeddingFn?: EmbeddingFn | null;
  /** Optional logger (defaults to console-based logger) */
  logger?: Logger;
  /** Optional workspace id for memory isolation */
  workspaceId?: string;
}

/**
 * JsonlMemoryProvider — file-based memory persistence.
 * Implements the pluggable MemoryProvider interface.
 */
export class JsonlMemoryProvider implements MemoryProvider {
  readonly name = "jsonl";
  private store: MemoryStore;
  private options: JsonlMemoryProviderOptions;
  private initialized = false;

  constructor(opts: JsonlMemoryProviderOptions) {
    this.options = opts;
    this.store = new MemoryStore({
      basePath: opts.basePath,
      embeddingFn: opts.embeddingFn ?? null,
      logger: opts.logger,
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async addMemory(input: MemoryInput): Promise<Memory> {
    const enriched = this.options.workspaceId
      ? { ...input, workspaceId: this.options.workspaceId }
      : input;
    return this.store.add(enriched);
  }

  async loadMemories(limit?: number): Promise<Memory[]> {
    return this.store.loadMemories(limit);
  }

  async searchMemories(query: string, limit?: number): Promise<Memory[]> {
    return this.store.search(query, limit);
  }

  async getRelevantMemories(tags: string[], limit?: number): Promise<Memory[]> {
    return this.store.getRelevantMemories(tags, limit);
  }

  async buildMemoryContext(currentTopic?: string): Promise<string> {
    return this.store.buildMemoryContext(currentTopic);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    return this.store.getStats();
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null> {
    return this.store.update(id, patch);
  }

  async touchMemory(id: string): Promise<void> {
    return this.store.touch(id);
  }
}
