// Engram — MemoryStore V1 测试
// 使用临时目录测试 JSONL 持久化 + CRUD + 搜索

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./stores/memoryStore";
import type { EmbeddingFn } from "./stores/memoryStore";
import type { Memory, MemoryInput } from "./types/memory";

// ── Helpers ──

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-test-"));
}

function makeInput(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: "fact",
    content: "test memory content",
    context: "",
    tags: [],
    confidence: 0.8,
    source: "test",
    ...overrides,
  };
}

async function seedMemories(store: MemoryStore, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = await store.add(makeInput({ content: `memory ${i}` }));
    ids.push(m.id);
  }
  return ids;
}

// ── Tests ──

describe("MemoryStore", () => {
  let basePath: string;
  let store: MemoryStore;

  beforeEach(() => {
    basePath = createTempDir();
    store = new MemoryStore({ basePath });
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  describe("add", () => {
    it("should add a memory and return it with generated fields", async () => {
      const mem = await store.add(makeInput({ content: "hello world" }));

      expect(mem.id).toBeTruthy();
      expect(mem.createdAt).toBeTruthy();
      expect(mem.lastUsed).toBeTruthy();
      expect(mem.accessCount).toBe(0);
      expect(mem.content).toBe("hello world");
      expect(mem.type).toBe("fact");
      expect(mem.confidence).toBe(0.8);
    });

    it("should persist to JSONL file", async () => {
      await store.add(makeInput({ content: "persist test" }));

      const jsonlPath = join(basePath, "memories.jsonl");
      expect(existsSync(jsonlPath)).toBe(true);

      const content = readFileSync(jsonlPath, "utf-8");
      expect(content).toContain("persist test");
    });

    it("should handle all memory types", async () => {
      const types: MemoryInput["type"][] = [
        "fact", "lesson", "preference", "correction", "pattern",
        "customer_fact", "commitment", "objection", "competitor_intel",
        "market_signal", "session_bridge", "mistake", "failure_mode", "custom",
      ];

      for (const type of types) {
        const mem = await store.add(makeInput({ type, content: `type: ${type}` }));
        expect(mem.type).toBe(type);
      }

      const all = await store.loadMemories(100);
      expect(all.length).toBe(types.length);
    });
  });

  describe("loadMemories", () => {
    it("should return memories in reverse chronological order", async () => {
      const m1 = await store.add(makeInput({ content: "first" }));
      const m2 = await store.add(makeInput({ content: "second" }));
      const m3 = await store.add(makeInput({ content: "third" }));

      const loaded = await store.loadMemories(10);
      expect(loaded.length).toBe(3);
      expect(loaded[0].content).toBe("third");
      expect(loaded[1].content).toBe("second");
      expect(loaded[2].content).toBe("first");
    });

    it("should respect limit", async () => {
      await seedMemories(store, 10);
      const loaded = await store.loadMemories(3);
      expect(loaded.length).toBe(3);
    });

    it("should return all when limit is 0", async () => {
      await seedMemories(store, 5);
      const loaded = await store.loadMemories(0);
      expect(loaded.length).toBe(5);
    });

    it("should return empty array when no memories exist", async () => {
      const loaded = await store.loadMemories();
      expect(loaded).toEqual([]);
    });
  });

  describe("search", () => {
    it("should find memories by keyword in content", async () => {
      await store.add(makeInput({ content: "user likes dark mode" }));
      await store.add(makeInput({ content: "user prefers email communication" }));
      await store.add(makeInput({ content: "office hours are 9-5" }));

      const results = await store.search("dark mode");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe("user likes dark mode");
    });

    it("should search in context field", async () => {
      await store.add(makeInput({
        content: "meeting notes",
        context: "discussed quarterly budget allocation",
      }));

      const results = await store.search("budget");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe("meeting notes");
    });

    it("should search in tags", async () => {
      await store.add(makeInput({
        content: "prefers phone calls",
        tags: ["preference", "communication"],
      }));

      const results = await store.search("preference");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should exclude archived memories from search results", async () => {
      await store.add(makeInput({ content: "active memory" }));
      const archived = await store.add(makeInput({ content: "archived memory" }));
      await store.update(archived.id, { archived: true });

      const results = await store.search("memory");
      expect(results.some((m) => m.content === "archived memory")).toBe(false);
      expect(results.some((m) => m.content === "active memory")).toBe(true);
    });

    it("should return empty array when no match", async () => {
      await store.add(makeInput({ content: "hello" }));
      const results = await store.search("zzz_nonexistent_zzz");
      expect(results).toEqual([]);
    });
  });

  describe("getRelevantMemories", () => {
    it("should find memories by tag overlap", async () => {
      await store.add(makeInput({
        content: "customer likes fast shipping",
        tags: ["shipping", "preference"],
        confidence: 0.9,
      }));
      await store.add(makeInput({
        content: "warehouse location",
        tags: ["logistics", "operations"],
        confidence: 0.8,
      }));

      const results = await store.getRelevantMemories(["shipping", "preference"]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("shipping");
    });

    it("should return empty array for unmatched tags", async () => {
      await store.add(makeInput({ content: "test", tags: ["a"] }));
      const results = await store.getRelevantMemories(["nonexistent"]);
      expect(results).toEqual([]);
    });
  });

  describe("buildMemoryContext", () => {
    it("should build a formatted context string", async () => {
      await store.add(makeInput({
        type: "customer_fact",
        content: "John is the decision maker",
        customerId: "cust-1",
      }));

      const ctx = await store.buildMemoryContext();
      expect(ctx).toContain("[Engram Memory");
      expect(ctx).toContain("[customer_fact]");
      expect(ctx).toContain("[cust-1] John is the decision maker");
    });

    it("should return empty string when no memories exist", async () => {
      const ctx = await store.buildMemoryContext();
      expect(ctx).toBe("");
    });
  });

  describe("delete", () => {
    it("should delete a memory by id", async () => {
      const mem = await store.add(makeInput({ content: "delete me" }));
      expect(await store.loadMemories(10)).toHaveLength(1);

      const deleted = await store.delete(mem.id);
      expect(deleted).toBe(true);
      expect(await store.loadMemories(10)).toHaveLength(0);
    });

    it("should return false if id not found", async () => {
      const deleted = await store.delete("nonexistent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("update", () => {
    it("should update memory fields", async () => {
      const mem = await store.add(makeInput({ content: "original content" }));

      const updated = await store.update(mem.id, {
        content: "updated content",
        confidence: 0.95,
      });

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("updated content");
      expect(updated!.confidence).toBe(0.95);
      // Preserved fields
      expect(updated!.type).toBe("fact");
    });

    it("should return null if id not found", async () => {
      const result = await store.update("nonexistent-id", { content: "new" });
      expect(result).toBeNull();
    });

    it("should update lastUsed timestamp on update", async () => {
      const mem = await store.add(makeInput({ content: "test" }));
      const original = mem.lastUsed;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      const updated = await store.update(mem.id, { confidence: 1.0 });

      expect(updated!.lastUsed).not.toBe(original);
    });
  });

  describe("touch", () => {
    it("should increment accessCount and update lastUsed", async () => {
      const mem = await store.add(makeInput({ content: "test" }));
      expect(mem.accessCount).toBe(0);

      await store.touch(mem.id);
      const all = await store.loadMemories(10);
      expect(all[0].accessCount).toBe(1);
    });
  });

  describe("loadByCustomer", () => {
    it("should filter memories by customerId", async () => {
      await store.add(makeInput({ customerId: "cust-1", content: "for cust 1" }));
      await store.add(makeInput({ customerId: "cust-2", content: "for cust 2" }));
      await store.add(makeInput({ customerId: "cust-1", content: "also for cust 1" }));

      const results = await store.loadByCustomer("cust-1");
      expect(results).toHaveLength(2);
      expect(results.every((m) => m.customerId === "cust-1")).toBe(true);
    });
  });

  describe("snapshots", () => {
    it("should create and count snapshots", async () => {
      await seedMemories(store, 5);
      const snap = await store.createSnapshot();
      expect(snap.count).toBe(5);
      expect(snap.path).toContain("snapshot-");

      const stats = await store.getSnapshotStats();
      expect(stats.snapshotsCount).toBeGreaterThanOrEqual(1);
      expect(stats.latestCount).toBe(5);
    });

    it("should return zero stats when no snapshots exist", async () => {
      const stats = await store.getSnapshotStats();
      expect(stats.snapshotsCount).toBe(0);
      expect(stats.latestSnapshot).toBeNull();
      expect(stats.latestCount).toBe(0);
    });
  });

  describe("exportAll / importAll", () => {
    it("should export all memories", async () => {
      await seedMemories(store, 3);
      const exported = await store.exportAll();
      expect(exported).toHaveLength(3);
    });

    it("should import new memories and dedup by id", async () => {
      const mem = await store.add(makeInput({ content: "original" }));
      const imported = await store.importAll([
        mem, // duplicate — should be skipped
        { ...makeInput({ content: "new" }), id: "new-id", createdAt: new Date().toISOString(), lastUsed: new Date().toISOString(), accessCount: 0 },
      ]);

      expect(imported).toBe(1); // only the new one
      expect(await (await store.loadMemories(10)).length).toBe(2);
    });
  });

  describe("getStats", () => {
    it("should return correct memory statistics", async () => {
      await store.add(makeInput({ type: "fact", content: "f1" }));
      await store.add(makeInput({ type: "fact", content: "f2" }));
      await store.add(makeInput({ type: "preference", content: "p1" }));

      const stats = await store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byType.fact).toBe(2);
      expect(stats.byType.preference).toBe(1);
      expect(stats.oldestEntry).toBeTruthy();
      expect(stats.newestEntry).toBeTruthy();
    });
  });

  describe("clear", () => {
    it("should clear all memories", async () => {
      await seedMemories(store, 5);
      expect(await (await store.loadMemories(10)).length).toBe(5);

      await store.clear();
      expect(await (await store.loadMemories(10)).length).toBe(0);
    });
  });

  describe("embedding integration", () => {
    it("should call custom embedding function when configured", async () => {
      const embeddingsGenerated: string[] = [];

      const storeWithEmb = new MemoryStore({
        basePath,
        embeddingFn: async (text) => {
          embeddingsGenerated.push(text);
          return Array.from({ length: 4 }, () => Math.random()); // 4-dim mock embedding
        },
      });

      await storeWithEmb.add(makeInput({ content: "embed this text" }));
      expect(embeddingsGenerated.length).toBeGreaterThanOrEqual(1);
      expect(embeddingsGenerated[0]).toContain("embed this text");
    });

    it("should fall back to keyword search when embedding fails", async () => {
      const failingEmb: EmbeddingFn = async () => null;

      const storeWithEmb = new MemoryStore({
        basePath,
        embeddingFn: failingEmb,
      });

      await storeWithEmb.add(makeInput({ content: "findable content" }));

      // Should still find via keyword even though embedding returns null
      const results = await storeWithEmb.search("findable");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe("findable content");
    });
  });

  describe("edge cases", () => {
    it("should handle empty content strings", async () => {
      const mem = await store.add(makeInput({ content: "" }));
      expect(mem.id).toBeTruthy();

      const loaded = await store.loadMemories(10);
      expect(loaded).toHaveLength(1);
    });

    it("should handle very long content", async () => {
      const longContent = "A".repeat(10000);
      const mem = await store.add(makeInput({ content: longContent }));
      expect(mem.content.length).toBe(10000);

      const loaded = await store.loadMemories(10);
      expect(loaded[0].content.length).toBe(10000);
    });

    it("should recover from corrupted JSONL", async () => {
      // Create corrupted JSONL with one valid + two corrupted lines
      const jsonlPath = join(basePath, "memories.jsonl");
      await mkdir(basePath, { recursive: true });
      const validEntry: Memory = {
        id: "valid-id",
        type: "fact",
        content: "valid line",
        context: "",
        tags: [],
        confidence: 0.5,
        source: "test",
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        accessCount: 0,
      };
      await writeFile(jsonlPath, JSON.stringify(validEntry) + "\ncorrupted json{\ngarbage\n");

      const loaded = await store.loadMemories(10);
      // Should load the valid line and skip the corrupted ones
      expect(loaded.length).toBe(1);
      expect(loaded[0].content).toBe("valid line");
    });
  });
});
