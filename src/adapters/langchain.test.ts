// Engram — LangChainMemoryAdapter Tests
// Tests the LangChain memory adapter against both JsonlMemoryProvider and
// SqliteMemoryProvider (when available).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LangChainMemoryAdapter } from "./langchain";
import type { MemoryProvider } from "../types/pluginTypes";
import { JsonlMemoryProvider } from "../providers/jsonlProvider";

// ── Helpers ──

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-langchain-test-"));
}

async function createProvider(): Promise<MemoryProvider> {
  const basePath = createTempDir();
  const provider = new JsonlMemoryProvider({ basePath });
  await provider.initialize();
  return provider;
}

async function destroyProvider(provider: MemoryProvider, basePath?: string): Promise<void> {
  await provider.shutdown();
  if (basePath) {
    await rm(basePath, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Tests ──

describe("LangChainMemoryAdapter", () => {
  let provider: MemoryProvider;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    provider = new JsonlMemoryProvider({ basePath: tmpDir });
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should create adapter with default config", () => {
      const adapter = new LangChainMemoryAdapter(provider);
      expect(adapter).toBeInstanceOf(LangChainMemoryAdapter);
    });

    it("should accept custom config", () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "custom-session",
        humanPrefix: "User",
        aiPrefix: "Assistant",
        memoryLimit: 5,
      });
      expect(adapter).toBeInstanceOf(LangChainMemoryAdapter);
    });
  });

  describe("saveContext", () => {
    it("should save a conversation turn as a memory entry", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "test-session",
      });

      await adapter.saveContext(
        { input: "Hello" },
        { output: "Hi there!" },
      );

      const memories = await provider.loadMemories(10);
      expect(memories.length).toBe(1);
      expect(memories[0].type).toBe("fact");
      expect(memories[0].content).toBe("Human: Hello\nAI: Hi there!");
      expect(memories[0].tags).toContain("langchain_memory");
      expect(memories[0].source).toBe("test-session");
    });

    it("should save multiple turns in order", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "multi-turn",
      });

      await adapter.saveContext(
        { input: "First" },
        { output: "First response" },
      );
      await adapter.saveContext(
        { input: "Second" },
        { output: "Second response" },
      );

      const memories = await provider.loadMemories(10);
      expect(memories.length).toBe(2);
      // Newest first
      expect(memories[0].content).toContain("Second");
      expect(memories[1].content).toContain("First");
    });

    it("should respect custom human/ai prefixes", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "prefix-test",
        humanPrefix: "User",
        aiPrefix: "Bot",
      });

      await adapter.saveContext(
        { input: "Hello" },
        { output: "Hi" },
      );

      const memories = await provider.loadMemories(10);
      expect(memories[0].content).toBe("User: Hello\nBot: Hi");
    });

    it("should handle alternate input key names", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "alt-keys",
      });

      await adapter.saveContext(
        { question: "What is AI?" },
        { answer: "Artificial Intelligence" },
      );

      const memories = await provider.loadMemories(10);
      expect(memories[0].content).toBe("Human: What is AI?\nAI: Artificial Intelligence");
    });

    it("should handle missing input gracefully", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "missing-input",
      });

      await adapter.saveContext({}, {});

      const memories = await provider.loadMemories(10);
      expect(memories[0].content).toContain("[input not provided]");
      expect(memories[0].content).toContain("[output not provided]");
    });

    it("should handle object values by stringifying them", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "object-input",
      });

      await adapter.saveContext(
        { input: { text: "hello", lang: "en" } },
        { output: { text: "hi", lang: "en" } },
      );

      const memories = await provider.loadMemories(10);
      expect(memories[0].content).toContain('"text":"hello"');
      expect(memories[0].content).toContain('"text":"hi"');
    });
  });

  describe("loadMemoryVariables", () => {
    it("should return empty history when no memories exist", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "empty-test",
      });

      const vars = await adapter.loadMemoryVariables({});
      expect(vars.history).toBe("");
    });

    it("should return formatted conversation history", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "load-test",
      });

      await adapter.saveContext(
        { input: "Hello" },
        { output: "Hi there!" },
      );

      const vars = await adapter.loadMemoryVariables({});
      expect(vars.history).toBe("Human: Hello\nAI: Hi there!");
    });

    it("should return multi-turn history (newest first)", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "multi-load",
      });

      await adapter.saveContext(
        { input: "Turn 1" },
        { output: "Response 1" },
      );
      await adapter.saveContext(
        { input: "Turn 2" },
        { output: "Response 2" },
      );

      const vars = await adapter.loadMemoryVariables({});
      const lines = vars.history.split("\n");

      // Newest turn appears first
      expect(lines[0]).toBe("Human: Turn 2");
      expect(lines[1]).toBe("AI: Response 2");
    });

    it("should respect memoryLimit configuration", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "limit-test",
      });

      // Save 5 turns
      for (let i = 1; i <= 5; i++) {
        await adapter.saveContext(
          { input: `Turn ${i}` },
          { output: `Response ${i}` },
        );
      }

      // Load with limit of 3
      const limitedAdapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "limit-test",
        memoryLimit: 3,
      });

      const vars = await limitedAdapter.loadMemoryVariables({});
      const turnCount = vars.history.split("Human:").length - 1;
      expect(turnCount).toBe(3);
    });

    it("should only load memories from the same session", async () => {
      const adapterA = new LangChainMemoryAdapter(provider, {
        sessionKey: "session-a",
      });
      const adapterB = new LangChainMemoryAdapter(provider, {
        sessionKey: "session-b",
      });

      await adapterA.saveContext(
        { input: "From A" },
        { output: "Response A" },
      );
      await adapterB.saveContext(
        { input: "From B" },
        { output: "Response B" },
      );

      const varsA = await adapterA.loadMemoryVariables({});
      expect(varsA.history).toContain("From A");
      expect(varsA.history).not.toContain("From B");

      const varsB = await adapterB.loadMemoryVariables({});
      expect(varsB.history).toContain("From B");
      expect(varsB.history).not.toContain("From A");
    });

    it("should respect maxTokensHint truncation", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "truncate-test",
      });

      // Save a long turn
      await adapter.saveContext(
        { input: "Hello" },
        { output: "A".repeat(500) },
      );

      // Load with very small maxTokensHint to force truncation
      const truncAdapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "truncate-test",
        maxTokensHint: 50,
      });

      const vars = await truncAdapter.loadMemoryVariables({});
      // Should be truncated to ~50 chars or less
      expect(vars.history.length).toBeLessThanOrEqual(60);
      expect(vars.history.length).toBeLessThan(500);
    });
  });

  describe("clear", () => {
    it("should clear all adapter-managed memories", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "clear-test",
      });

      await adapter.saveContext(
        { input: "Hello" },
        { output: "Hi" },
      );
      await adapter.saveContext(
        { input: "How are you?" },
        { output: "I'm good!" },
      );

      expect((await provider.loadMemories(10)).length).toBe(2);

      await adapter.clear();

      const afterClear = await provider.loadMemories(0);
      expect(afterClear.length).toBe(0);
    });

    it("should not clear non-adapter memories", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "clear-scoped",
      });

      // Add an adapter memory
      await adapter.saveContext(
        { input: "Adapter memory" },
        { output: "Should be cleared" },
      );

      // Add a non-adapter memory
      await provider.addMemory({
        type: "fact",
        content: "This should survive clear",
        context: "manual entry",
        tags: ["manual"],
        confidence: 0.9,
        source: "manual",
      });

      await adapter.clear();

      const remaining = await provider.loadMemories(0);
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toBe("This should survive clear");
    });

    it("should not clear memories from other sessions", async () => {
      const adapterA = new LangChainMemoryAdapter(provider, {
        sessionKey: "session-clear-a",
      });
      const adapterB = new LangChainMemoryAdapter(provider, {
        sessionKey: "session-clear-b",
      });

      // Create memories in both sessions
      const memoryContent: string[] = [];

      await adapterA.saveContext(
        { input: "Session A turn" },
        { output: "A response" },
      );
      memoryContent.push("Session A turn");

      await adapterB.saveContext(
        { input: "Session B turn" },
        { output: "B response" },
      );
      memoryContent.push("Session B turn");

      // Clear only session A
      await adapterA.clear();

      const remaining = await provider.loadMemories(0);

      // Session B's memory should survive
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toContain("Session B turn");
    });

    it("should leave history empty after clear", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "clear-history",
      });

      await adapter.saveContext(
        { input: "Hello" },
        { output: "Hi" },
      );

      await adapter.clear();

      const vars = await adapter.loadMemoryVariables({});
      expect(vars.history).toBe("");
    });
  });

  describe("BaseMemory interface compliance", () => {
    it("should implement all BaseMemory methods", () => {
      const adapter = new LangChainMemoryAdapter(provider);
      expect(typeof adapter.loadMemoryVariables).toBe("function");
      expect(typeof adapter.saveContext).toBe("function");
      expect(typeof adapter.clear).toBe("function");
    });

    it("should return MemoryVariables with history key on load", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "interface-test",
      });

      const emptyVars = await adapter.loadMemoryVariables({});
      expect(emptyVars).toHaveProperty("history");
      expect(typeof emptyVars.history).toBe("string");
    });

    it("should work with empty inputValues object", async () => {
      const adapter = new LangChainMemoryAdapter(provider, {
        sessionKey: "empty-inputs",
      });

      await adapter.saveContext(
        { input: "Hi" },
        { output: "Hello" },
      );

      // loadMemoryVariables with no argument
      const vars = await (adapter as any).loadMemoryVariables();
      expect(vars.history).toBeTruthy();
    });
  });

  describe("cross-provider compatibility", () => {
    it("should work identically when used with multiple provider instances", async () => {
      const tmpDir2 = createTempDir();
      const provider2 = new JsonlMemoryProvider({ basePath: tmpDir2 });
      await provider2.initialize();

      try {
        const adapter1 = new LangChainMemoryAdapter(provider, {
          sessionKey: "cross-prod",
        });
        const adapter2 = new LangChainMemoryAdapter(provider2, {
          sessionKey: "cross-prod",
        });

        await adapter1.saveContext(
          { input: "Hello" },
          { output: "World" },
        );

        const vars1 = await adapter1.loadMemoryVariables({});
        const vars2 = await adapter2.loadMemoryVariables({});

        // Different providers = different data stores
        expect(vars1.history).toBeTruthy();
        expect(vars2.history).toBe("");
      } finally {
        await provider2.shutdown();
        await rm(tmpDir2, { recursive: true, force: true });
      }
    });
  });
});
