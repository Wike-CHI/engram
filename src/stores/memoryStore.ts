// Engram — MemoryStore (V1)
// JSONL-based memory persistence with optional semantic search.
// Zero platform dependencies — base path is injected at construction time.
// Ported from holo-desktop memoryStore.ts, stripped of Electron deps.

import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  Memory,
  MemoryInput,
  MemoryPatch,
  MemoryType,
  MemoryScope,
  MemoryStats,
} from "../types/memory";

// ══════════════════════════════════════════════════════════════
// Embedding function type (injectable — configured by consumer)
// ══════════════════════════════════════════════════════════════

export type EmbeddingFn = (text: string) => Promise<number[] | null>;

// ══════════════════════════════════════════════════════════════
// Logger type (injectable — defaults to console)
// ══════════════════════════════════════════════════════════════

export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(`[engram] ${msg}`),
  warn: (msg) => console.warn(`[engram] ${msg}`),
  error: (msg) => console.error(`[engram] ${msg}`),
};

// ══════════════════════════════════════════════════════════════
// V1 MemoryStore
// ══════════════════════════════════════════════════════════════

export class MemoryStore {
  private basePath: string;
  private embeddingFn: EmbeddingFn | null;
  private logger: Logger;

  constructor(opts: {
    basePath: string;
    embeddingFn?: EmbeddingFn | null;
    logger?: Logger;
  }) {
    this.basePath = opts.basePath;
    this.embeddingFn = opts.embeddingFn ?? null;
    this.logger = opts.logger ?? defaultLogger;
  }

  /** Path to the JSONL memories file */
  private memoriesPath(): string {
    return join(this.basePath, "memories.jsonl");
  }

  /** Snapshots directory */
  private snapshotsDir(): string {
    return join(this.basePath, "snapshots");
  }

  /** Ensure storage directory exists */
  private async ensureDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /** Build text for embedding from a memory input */
  private textForEmbedding(input: MemoryInput): string {
    const parts = [input.type, input.content];
    if (input.context) parts.push(input.context);
    if (input.tags.length) parts.push(input.tags.join(" "));
    return parts.join(" | ");
  }

  /** Compute cosine similarity between two vectors */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Read all memories from JSONL file — skips corrupted lines */
  private async readAll(): Promise<Memory[]> {
    const path = this.memoriesPath();
    if (!existsSync(path)) return [];
    const content = await readFile(path, "utf-8");
    const result: Memory[] = [];
    for (const line of content.trim().split("\n").filter(Boolean)) {
      try {
        result.push(JSON.parse(line) as Memory);
      } catch {
        // skip corrupted lines — resilience over strictness
      }
    }
    return result;
  }

  /** Write all memories to JSONL file */
  private async writeAll(memories: Memory[]): Promise<void> {
    await this.ensureDir();
    const lines = memories.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(this.memoriesPath(), lines, "utf-8");
  }

  /** Append a single memory as a new line */
  private async append(memory: Memory): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(memory) + "\n";
    await writeFile(this.memoriesPath(), line, { flag: "a" });
  }

  // ══════════════════════════════════════════════
  // Public CRUD API
  // ══════════════════════════════════════════════

  /** Add a new memory — auto-generates id, timestamps, and optionally embeds content */
  async add(input: MemoryInput): Promise<Memory> {
    const memory: Memory = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      accessCount: 0,
    };

    // Generate embedding if applicable
    if (this.embeddingFn && !input.embedding) {
      try {
        const text = this.textForEmbedding(input);
        const emb = await this.embeddingFn(text);
        if (emb) memory.embedding = emb;
      } catch {
        // embedding is best-effort
      }
    }

    await this.append(memory);
    return memory;
  }

  /** Load recent memories (newest first) */
  async loadMemories(limit = 50): Promise<Memory[]> {
    const all = await this.readAll();
    const result = limit > 0 ? all.slice(-limit) : all;
    return result.reverse();
  }

  /** Search memories by text query.
   *  Uses semantic search (cosine similarity) if embeddingFn is configured and
   *  the stored memories have embeddings. Falls back to word-level keyword matching. */
  async search(query: string, limit = 10): Promise<Memory[]> {
    const all = await this.readAll();
    const active = all.filter((m) => !m.archived);
    if (active.length === 0) return [];

    const lowerQuery = query.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter(Boolean);

    // Keyword match function: matches if any query word appears in content/context/tags
    const matchesKeyword = (m: Memory): boolean => {
      if (lowerQuery.length < 3) {
        // Very short queries: exact substring match
        return (
          m.content.toLowerCase().includes(lowerQuery) ||
          m.context.toLowerCase().includes(lowerQuery) ||
          m.tags.some((t) => t.toLowerCase().includes(lowerQuery))
        );
      }
      // Multi-word: match if ANY word appears in content or tags
      return queryWords.some(
        (word) =>
          m.content.toLowerCase().includes(word) ||
          m.context.toLowerCase().includes(word) ||
          m.tags.some((t) => t.toLowerCase().includes(word)),
      );
    };

    // Try semantic search first
    if (this.embeddingFn) {
      try {
        const queryEmb = await this.embeddingFn(query);
        if (queryEmb && active.some((m) => m.embedding?.length)) {
          const scored = active
            .filter((m) => m.embedding?.length)
            .map((m) => ({
              memory: m,
              score: this.cosineSimilarity(queryEmb, m.embedding!),
            }))
            .sort((a, b) => b.score - a.score);

          const semanticResults = scored.slice(0, limit).map((s) => s.memory);

          // Fill remaining slots with keyword matches
          if (semanticResults.length < limit) {
            const keywordHits = active
              .filter((m) => !semanticResults.includes(m))
              .filter(matchesKeyword)
              .slice(0, limit - semanticResults.length);
            return [...semanticResults, ...keywordHits];
          }

          return semanticResults;
        }
      } catch {
        // fall through to keyword search
      }
    }

    // Keyword fallback — word-level matching
    return active.filter(matchesKeyword).slice(0, limit);
  }

  /** Get relevant memories by tags, scored by confidence + recency */
  async getRelevantMemories(tags: string[], limit = 10): Promise<Memory[]> {
    const all = await this.readAll();
    const active = all.filter((m) => !m.archived);
    if (active.length === 0 || tags.length === 0) return [];

    const now = Date.now();

    const scored = active
      .map((m) => {
        const tagOverlap = tags.filter((t) => m.tags.includes(t)).length;
        if (tagOverlap === 0) return null;

        const recencyScore = Math.min(
          1,
          (now - new Date(m.lastUsed).getTime()) / (7 * 24 * 3600000),
        );
        const score = tagOverlap * 2 + m.confidence * 0.5 + (1 - recencyScore) * 0.3;

        return { memory: m, score };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.memory);
  }

  /** Build a formatted context string for system prompt injection */
  async buildMemoryContext(currentTopic?: string): Promise<string> {
    const all = await this.readAll();
    const active = all.filter((m) => !m.archived).slice(-30);

    if (active.length === 0) return "";

    const lines = active.map((m) => {
      const tag = m.customerId ? `[${m.customerId}] ` : "";
      return `- [${m.type}] ${tag}${m.content}`;
    });

    return `[Engram Memory — 相关记忆]\n${lines.join("\n")}`;
  }

  /** Get memory statistics */
  async getStats(): Promise<MemoryStats> {
    const all = await this.readAll();
    const byType: Record<string, number> = {};

    for (const m of all) {
      byType[m.type] = (byType[m.type] ?? 0) + 1;
    }

    const sorted = all.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return {
      total: all.length,
      byType,
      oldestEntry: sorted[0]?.createdAt,
      newestEntry: sorted[sorted.length - 1]?.createdAt,
    };
  }

  /** Delete a memory by id */
  async delete(id: string): Promise<boolean> {
    const all = await this.readAll();
    const filtered = all.filter((m) => m.id !== id);
    if (filtered.length === all.length) return false;
    await this.writeAll(filtered);
    return true;
  }

  /** Update specific fields of a memory entry */
  async update(id: string, patch: MemoryPatch): Promise<Memory | null> {
    const all = await this.readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return null;

    all[idx] = { ...all[idx], ...patch, lastUsed: new Date().toISOString() };

    // Re-embed if content changed and embedding is available
    if (patch.content && this.embeddingFn) {
      try {
        const text = this.textForEmbedding({
          type: all[idx].type,
          content: all[idx].content,
          context: all[idx].context,
          tags: all[idx].tags,
          confidence: all[idx].confidence,
          source: all[idx].source,
        });
        const emb = await this.embeddingFn(text);
        if (emb) all[idx].embedding = emb;
      } catch {
        // best-effort
      }
    }

    await this.writeAll(all);
    return all[idx];
  }

  /** Update lastUsed timestamp (called when memory is retrieved) */
  async touch(id: string): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return;
    all[idx].lastUsed = new Date().toISOString();
    all[idx].accessCount += 1;
    await this.writeAll(all);
  }

  /** Load memories filtered by customerId */
  async loadByCustomer(customerId: string, limit = 20): Promise<Memory[]> {
    const all = await this.readAll();
    return all
      .filter((m) => m.customerId === customerId && !m.archived)
      .slice(-limit)
      .reverse();
  }

  // ══════════════════════════════════════════════
  // Snapshot support
  // ══════════════════════════════════════════════

  /** Create a timestamped snapshot backup */
  async createSnapshot(): Promise<{ path: string; count: number }> {
    await this.ensureDir();
    const snapDir = this.snapshotsDir();
    await mkdir(snapDir, { recursive: true });

    const all = await this.readAll();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapPath = join(snapDir, `snapshot-${timestamp}.jsonl`);

    const lines = all.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(snapPath, lines, "utf-8");

    // Clean old snapshots (keep last 7)
    const files = (await readdir(snapDir)).filter((f) => f.startsWith("snapshot-"));
    if (files.length > 7) {
      const sorted = files.sort();
      for (const old of sorted.slice(0, sorted.length - 7)) {
        await rm(join(snapDir, old), { force: true });
      }
    }

    this.logger.info(`快照已创建: ${snapPath} (${all.length} 条记忆)`);
    return { path: snapPath, count: all.length };
  }

  /** Get snapshot statistics */
  async getSnapshotStats(): Promise<{
    snapshotsCount: number;
    latestSnapshot: string | null;
    latestCount: number;
  }> {
    const snapDir = this.snapshotsDir();
    if (!existsSync(snapDir)) {
      return { snapshotsCount: 0, latestSnapshot: null, latestCount: 0 };
    }

    const files = (await readdir(snapDir)).filter((f) => f.startsWith("snapshot-"));
    if (files.length === 0) {
      return { snapshotsCount: 0, latestSnapshot: null, latestCount: 0 };
    }

    const latest = files.sort().reverse()[0];
    const content = await readFile(join(snapDir, latest), "utf-8");
    const count = content.trim().split("\n").filter(Boolean).length;

    return { snapshotsCount: files.length, latestSnapshot: latest, latestCount: count };
  }

  /** Load all memories for bulk export */
  async exportAll(): Promise<Memory[]> {
    return this.readAll();
  }

  /** Import memories from an array (used for migration) */
  async importAll(memories: Memory[]): Promise<number> {
    if (memories.length === 0) return 0;

    // Dedup by id
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((m) => m.id));
    const newMemories = memories.filter((m) => !existingIds.has(m.id));

    if (newMemories.length === 0) return 0;

    await this.writeAll([...existing, ...newMemories]);
    return newMemories.length;
  }

  /** Clear all memories (for testing or reset) */
  async clear(): Promise<void> {
    const path = this.memoriesPath();
    if (existsSync(path)) {
      await writeFile(path, "", "utf-8");
    }
  }
}

export { defaultLogger };
