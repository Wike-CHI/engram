// Engram — SqliteMemoryProvider 测试
// 使用 :memory: 数据库避免文件残留

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteMemoryProvider } from "./sqliteMemoryProvider";
import type { MemoryInput, Memory } from "../types/memory";

function makeInput(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    type: "fact",
    content: "test memory",
    context: "",
    tags: [],
    confidence: 0.8,
    source: "test",
    ...overrides,
  };
}

describe("SqliteMemoryProvider", () => {
  let provider: SqliteMemoryProvider;

  beforeEach(async () => {
    provider = new SqliteMemoryProvider({
      dbPath: ":memory:",
      Database: Database as any,
    });
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  describe("CRUD", () => {
    it("should add and load memories", async () => {
      const mem = await provider.addMemory(makeInput({ content: "hello sqlite" }));

      expect(mem.id).toBeTruthy();
      expect(mem.createdAt).toBeTruthy();
      expect(mem.content).toBe("hello sqlite");

      const loaded = await provider.loadMemories(10);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].content).toBe("hello sqlite");
    });

    it("should load newest first", async () => {
      await provider.addMemory(makeInput({ content: "first" }));
      await provider.addMemory(makeInput({ content: "second" }));
      await provider.addMemory(makeInput({ content: "third" }));

      const loaded = await provider.loadMemories(10);
      expect(loaded[0].content).toBe("third");
      expect(loaded[2].content).toBe("first");
    });

    it("should handle all memory types", async () => {
      const types: MemoryInput["type"][] = [
        "fact", "lesson", "preference", "correction", "pattern",
        "customer_fact", "commitment", "objection", "competitor_intel",
        "market_signal", "session_bridge", "mistake", "failure_mode", "custom",
      ];

      for (const type of types) {
        await provider.addMemory(makeInput({ type, content: `type: ${type}` }));
      }

      const all = await provider.loadMemories(100);
      expect(all.length).toBe(types.length);
    });
  });

  describe("Search (FTS5 + fallback)", () => {
    it("should find memories by FTS5 BM25 search", async () => {
      await provider.addMemory(makeInput({ content: "user prefers dark mode interface" }));
      await provider.addMemory(makeInput({ content: "user likes email communication" }));

      const results = await provider.searchMemories("dark mode");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("dark mode");
    });

    it("should search in context field", async () => {
      await provider.addMemory(makeInput({
        content: "meeting notes",
        context: "discussed quarterly budget allocation",
      }));

      const results = await provider.searchMemories("budget");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should search in tags via JSON fallback", async () => {
      await provider.addMemory(makeInput({
        content: "prefers phone calls",
        tags: ["preference", "communication"],
      }));

      const results = await provider.searchMemories("preference");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle empty query", async () => {
      const results = await provider.searchMemories("");
      expect(results).toEqual([]);
    });

    it("should return empty when no match", async () => {
      await provider.addMemory(makeInput({ content: "hello" }));
      const results = await provider.searchMemories("zzz_nonexistent_zzz");
      expect(results).toEqual([]);
    });
  });

  describe("RelevantMemories by tags", () => {
    it("should find by tag overlap via FTS", async () => {
      await provider.addMemory(makeInput({
        content: "customer likes fast shipping",
        tags: ["shipping", "preference"],
        confidence: 0.9,
      }));

      const results = await provider.getRelevantMemories(["shipping"]);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty for no match", async () => {
      const results = await provider.getRelevantMemories(["nonexistent"]);
      expect(results).toEqual([]);
    });
  });

  describe("BuildMemoryContext", () => {
    it("should build formatted context", async () => {
      await provider.addMemory(makeInput({
        type: "customer_fact", content: "John is the decision maker",
      }));

      const ctx = await provider.buildMemoryContext();
      expect(ctx).toContain("[Engram Memory");
      expect(ctx).toContain("John is the decision maker");
    });

    it("should search by topic", async () => {
      await provider.addMemory(makeInput({
        content: "Q2 revenue target is $1M",
        tags: ["revenue"],
      }));

      const ctx = await provider.buildMemoryContext("revenue");
      expect(ctx).toContain("$1M");
    });
  });

  describe("Delete / Update / Touch", () => {
    it("should delete by id", async () => {
      const mem = await provider.addMemory(makeInput({ content: "delete me" }));
      expect((await provider.loadMemories(10)).length).toBe(1);

      const deleted = await provider.deleteMemory(mem.id);
      expect(deleted).toBe(true);
      expect((await provider.loadMemories(10)).length).toBe(0);
    });

    it("should return false when delete nonexistent", async () => {
      const result = await provider.deleteMemory("nonexistent");
      expect(result).toBe(false);
    });

    it("should update fields", async () => {
      const mem = await provider.addMemory(makeInput({ content: "original" }));
      const updated = await provider.updateMemory(mem.id, {
        content: "updated",
        confidence: 0.95,
      });

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("updated");
      expect(updated!.confidence).toBe(0.95);
    });

    it("should return null when update nonexistent", async () => {
      const result = await provider.updateMemory("nonexistent", { content: "new" });
      expect(result).toBeNull();
    });

    it("should touch and increment access count", async () => {
      const mem = await provider.addMemory(makeInput({ content: "test" }));
      await provider.touchMemory(mem.id);

      const loaded = await provider.loadMemories(10);
      expect(loaded[0].accessCount).toBe(1);
    });
  });

  describe("Stats", () => {
    it("should return correct stats", async () => {
      await provider.addMemory(makeInput({ type: "fact", content: "f1" }));
      await provider.addMemory(makeInput({ type: "fact", content: "f2" }));
      await provider.addMemory(makeInput({ type: "preference", content: "p1" }));

      const stats = await provider.getMemoryStats();
      expect(stats.total).toBe(3);
      expect(stats.byType.fact).toBe(2);
      expect(stats.byType.preference).toBe(1);
    });

    it("should return zero for empty store", async () => {
      const stats = await provider.getMemoryStats();
      expect(stats.total).toBe(0);
      expect(Object.keys(stats.byType)).toHaveLength(0);
    });
  });

  describe("Export / Import", () => {
    it("should export all memories", async () => {
      await provider.addMemory(makeInput({ content: "a" }));
      await provider.addMemory(makeInput({ content: "b" }));

      const exported = provider.exportMemories();
      expect(exported).toHaveLength(2);
    });

    it("should import and dedup by id", async () => {
      const mem = await provider.addMemory(makeInput({ content: "original" }));
      const imported = provider.importMemories([
        mem,
        { ...makeInput({ content: "new" }), id: "new-id", createdAt: new Date().toISOString(), lastUsed: new Date().toISOString(), accessCount: 0 },
      ]);

      expect(imported).toBe(1);
      expect(provider.exportMemories()).toHaveLength(2);
    });
  });

  describe("Snapshot", () => {
    it("should create snapshot backup (file-based db)", async () => {
      const tmpDir = require("node:os").tmpdir();
      const path = require("node:path");
      const fs = require("node:fs");
      const dbPath = path.join(tmpDir, `engram-snap-test-${Date.now()}.db`);
      const snapPath = path.join(tmpDir, `engram-snap-${Date.now()}.db`);

      const fileProvider = new SqliteMemoryProvider({
        dbPath,
        Database: Database as any,
      });
      await fileProvider.initialize();
      await fileProvider.addMemory(makeInput({ content: "for snapshot" }));

      const snap = fileProvider.createSnapshot(snapPath);
      expect(snap.count).toBe(1);
      expect(snap.path).toBeTruthy();

      await fileProvider.shutdown();
      try { fs.unlinkSync(dbPath); fs.unlinkSync(snapPath); } catch {}
    });
  });

  describe("Edge cases", () => {
    it("should handle empty content", async () => {
      const mem = await provider.addMemory(makeInput({ content: "" }));
      expect(mem.id).toBeTruthy();
    });

    it("should handle long content", async () => {
      const longContent = "A".repeat(10000);
      const mem = await provider.addMemory(makeInput({ content: longContent }));
      expect(mem.content.length).toBe(10000);
    });
  });
});
