// Engram — Phase 2 测试：EmbeddingEngine + WorkingMemoryManager + ActiveMemoryPlugin + ActiveMemoryEngine

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingEngine, createEmbeddingEngineFromEnv } from "./embedding/embeddingEngine";
import { WorkingMemoryManager } from "./working/workingMemoryManager";
import { ActiveMemoryPlugin } from "./plugin/activeMemoryPlugin";
import { ActiveMemoryEngine } from "./core/activeMemoryEngine";
import { JsonlMemoryProvider } from "./providers/jsonlProvider";
import type { PluginContext, Plugin } from "./types/pluginTypes";
import type { Memory } from "./types/memory";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-p2-test-"));
}

// ══════════════════════════════════════════════════════════════
// EmbeddingEngine
// ══════════════════════════════════════════════════════════════

describe("EmbeddingEngine", () => {
  it("should create with valid config", () => {
    const engine = new EmbeddingEngine({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    expect(engine.isAvailable()).toBe(true);
  });

  it("should detect missing config", () => {
    const engine = new EmbeddingEngine({ baseUrl: "", apiKey: "" });
    expect(engine.isAvailable()).toBe(false);
  });

  it("should handle API error gracefully", async () => {
    const engine = new EmbeddingEngine({
      baseUrl: "https://invalid.example.com",
      apiKey: "sk-test",
    });
    const result = await engine.embed("test");
    expect(result).toBeNull();
  });

  it("should create from environment", () => {
    const oldKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ENGRAM_EMBEDDING_API_KEY;

    const engine = createEmbeddingEngineFromEnv();
    expect(engine).toBeNull();

    process.env.OPENAI_API_KEY = "sk-env-test";
    const engine2 = createEmbeddingEngineFromEnv();
    expect(engine2).not.toBeNull();
    expect(engine2!.isAvailable()).toBe(true);

    if (oldKey) process.env.OPENAI_API_KEY = oldKey;
    else delete process.env.OPENAI_API_KEY;
  });
});

// ══════════════════════════════════════════════════════════════
// WorkingMemoryManager
// ══════════════════════════════════════════════════════════════

describe("WorkingMemoryManager", () => {
  let wmm: WorkingMemoryManager;

  beforeEach(() => {
    wmm = new WorkingMemoryManager();
  });

  afterEach(() => {
    wmm.disposeAll();
  });

  it("should initialize working memory", () => {
    const wm = wmm.init("run-1", "Research competitor pricing", ["Find price list", "Compare features"]);
    expect(wm.currentGoal).toBe("Research competitor pricing");
    expect(wm.subGoals).toHaveLength(2);
    expect(wm.progress).toBe(0);
  });

  it("should record steps and update progress", () => {
    wmm.init("run-1", "Test goal", ["sub1", "sub2"]);
    wmm.recordStep("run-1", 1, "Searched for data", ["web_search"], "success");
    wmm.recordStep("run-1", 2, "Found pricing page", ["web_search"], "success");

    const summary = wmm.generateSummary("run-1");
    expect(summary).toContain("Test goal");
    expect(summary).toContain("Searched for data");
  });

  it("should add findings and avoid duplicates", () => {
    wmm.init("run-1", "Test");
    wmm.addFinding("run-1", "customer_insight", "Customer prefers email", 1);
    wmm.addFinding("run-1", "customer_insight", "Customer prefers email", 2);

    const wm = wmm.get("run-1");
    expect(wm!.keyFindings).toHaveLength(1);
  });

  it("should update sub-goal status", () => {
    wmm.init("run-1", "Test", ["Research", "Implement"]);
    wmm.updateSubGoal("run-1", "sg-0", "completed");
    const wm = wmm.get("run-1");
    expect(wm!.progress).toBe(50);
    expect(wm!.subGoals[0].status).toBe("completed");
  });

  it("should detect drift on consecutive errors", () => {
    wmm.init("run-1", "Test");
    for (let i = 0; i < 3; i++) {
      wmm.recordStep("run-1", i, "Error ${i}", ["tool_x"], "error");
    }
    const drift = wmm.checkDrift("run-1");
    expect(drift.drifting).toBe(true);
    expect(drift.severity).toBeGreaterThanOrEqual(0.8);
    expect(drift.description).toContain("consecutive");
  });

  it("should detect tool loop drift", () => {
    wmm.init("run-1", "Test");
    for (let i = 0; i < 5; i++) {
      wmm.recordStep("run-1", i, "Step ${i}", ["same_tool"], "success");
    }
    const drift = wmm.checkDrift("run-1");
    expect(drift.drifting).toBe(true);
    expect(drift.description).toContain("loop");
  });

  it("should return null summary for unknown run", () => {
    expect(wmm.generateSummary("nonexistent")).toBeNull();
  });

  it("should dispose a single run", () => {
    wmm.init("run-1", "Test");
    wmm.dispose("run-1");
    expect(wmm.get("run-1")).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// ActiveMemoryPlugin integration
// ══════════════════════════════════════════════════════════════

describe("ActiveMemoryPlugin", () => {
  let basePath: string;
  let provider: JsonlMemoryProvider;
  let plugin: ActiveMemoryPlugin;
  let hooks: Record<string, Array<{ handler: Function; priority: number }>>;
  let tools: Array<{ name: string }>;
  let registeredProvider: any;

  function createMockContext(): PluginContext {
    hooks = {};
    tools = [];
    registeredProvider = null;
    return {
      pluginId: "test",
      registerHook: (name, handler, priority) => {
        if (!hooks[name]) hooks[name] = [];
        hooks[name].push({ handler, priority: priority ?? 0 });
      },
      registerTool: (tool) => { tools.push(tool); },
      registerMemoryProvider: (p) => { registeredProvider = p; },
      getConfig: () => undefined,
      setConfig: () => {},
    };
  }

  beforeEach(async () => {
    basePath = createTempDir();
    provider = new JsonlMemoryProvider({ basePath });
    await provider.initialize();
  });

  afterEach(async () => {
    await plugin?.shutdown();
    await rm(basePath, { recursive: true, force: true });
  });

  it("should register hooks and tools on activation", async () => {
    plugin = new ActiveMemoryPlugin({ memoryProvider: provider, storageBasePath: basePath, dailySnapshot: false });
    const ctx = createMockContext();
    await plugin.register(ctx);

    expect(registeredProvider).toBe(provider);
    expect(hooks.before_step).toBeDefined();
    expect(hooks.after_run).toBeDefined();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toBe("propose_memory");
  });

  it("should register before_step hooks with correct priorities", async () => {
    plugin = new ActiveMemoryPlugin({ memoryProvider: provider, storageBasePath: basePath, dailySnapshot: false, sessionBridge: true });
    const ctx = createMockContext();
    await plugin.register(ctx);

    expect(hooks.before_step).toHaveLength(3);
    expect(hooks.before_step[0].priority).toBe(10);
    expect(hooks.before_step[2].priority).toBe(60);
  });

  it("should propose and save memories through tool", async () => {
    plugin = new ActiveMemoryPlugin({ memoryProvider: provider, storageBasePath: basePath, dailySnapshot: false });
    const ctx = createMockContext();
    await plugin.register(ctx);

    const tool = tools[0];
    const result = await tool.execute({ type: "fact", content: "test fact" });
    expect(result).toEqual({ ok: true, message: "Memory proposed (1 pending)" });

    await hooks.after_run[0].handler({ steps: 3, durationMs: 6000, runId: "test-run", sessionKey: "test-session" });

    const memories = await provider.loadMemories(10);
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories.some((m) => m.content === "test fact")).toBe(true);
  });

  it("should propose memory with customer ID", async () => {
    plugin = new ActiveMemoryPlugin({ memoryProvider: provider, storageBasePath: basePath, dailySnapshot: false });
    const ctx = createMockContext();
    await plugin.register(ctx);

    await tools[0].execute({ type: "customer_fact", content: "John is decision maker", customerId: "cust-123" });
    await hooks.after_run[0].handler({ steps: 3, durationMs: 6000 });

    const memories = await provider.loadMemories(10);
    const johnFacts = memories.filter((m) => m.content.includes("John"));
    expect(johnFacts.length).toBeGreaterThanOrEqual(1);
    expect(johnFacts[0].customerId).toBe("cust-123");
  });

  it("should inject memories on before_step (L0)", async () => {
    await provider.addMemory({
      type: "fact", content: "User prefers dark mode", context: "", tags: ["preference"],
      confidence: 0.9, source: "test",
    });

    plugin = new ActiveMemoryPlugin({ memoryProvider: provider, storageBasePath: basePath, dailySnapshot: false });
    const ctx = createMockContext();
    await plugin.register(ctx);

    const context = { userMessage: "dark mode", step: 0 };
    await hooks.before_step[0].handler(context);

    expect((context as any)._engramMemories).toBeDefined();
    expect((context as any)._engramMemories.length).toBeGreaterThanOrEqual(1);
    expect((context as any)._engramMemories[0]).toContain("dark mode");
  });
});

// ══════════════════════════════════════════════════════════════
// ActiveMemoryEngine integration
// ══════════════════════════════════════════════════════════════

describe("ActiveMemoryEngine", () => {
  let basePath: string;
  let engine: ActiveMemoryEngine;

  beforeEach(() => {
    basePath = createTempDir();
    engine = new ActiveMemoryEngine({ storageBasePath: basePath, dailySnapshot: false });
  });

  afterEach(async () => {
    await engine.shutdown();
    await rm(basePath, { recursive: true, force: true });
  });

  it("should initialize and provide memory provider", async () => {
    await engine.initialize();
    const provider = engine.getProvider();
    expect(provider.name).toBe("jsonl");

    await provider.addMemory({
      type: "fact", content: "engine test", context: "", tags: [],
      confidence: 0.5, source: "test",
    });
    expect((await provider.loadMemories(10)).length).toBe(1);
  });

  it("should return relevant memories on before_step (L0)", async () => {
    await engine.initialize();
    const provider = engine.getProvider();
    await provider.addMemory({
      type: "fact", content: "Customer requested quote for PA300", context: "email",
      tags: ["quote", "pa300"], confidence: 0.9, source: "agent",
    });

    const result = await engine.beforeStep("quote for PA300", 0);
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    expect(result.memoryContext).toContain("quote for PA300");
    expect(result.memoryContext).toContain("[Engram");
  });

  it("should propose and save memories (L1)", async () => {
    await engine.initialize();
    const res = engine.proposeMemory("preference", "Customer likes WhatsApp", "cust-1");
    expect(res.ok).toBe(true);

    await engine.afterRun({ steps: 5, durationMs: 10000, sessionKey: "test-session" });

    const provider = engine.getProvider();
    const memories = await provider.loadMemories(10);
    const whatsapp = memories.filter((m) => m.content.includes("WhatsApp"));
    expect(whatsapp.length).toBeGreaterThanOrEqual(1);
    expect(whatsapp[0].customerId).toBe("cust-1");
  });

  it("should return empty context when no memories match", async () => {
    await engine.initialize();
    const result = await engine.beforeStep("zzz_nonexistent_zzz", 0);
    expect(result.memories).toHaveLength(0);
    expect(result.memoryContext).toBe("");
  });

  it("should not extract for short runs (L2 gate)", async () => {
    await engine.initialize();
    await engine.afterRun({ steps: 1, durationMs: 1000 });
  });

  it("should create session bridge after runs (L3)", async () => {
    await engine.initialize();
    await engine.afterRun({ steps: 5, durationMs: 10000, sessionKey: "session-1" });

    const provider = engine.getProvider();
    const bridges = await provider.searchMemories("session_bridge", 5);
    const sessionBridges = bridges.filter((m) => m.type === "session_bridge");
    expect(sessionBridges.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Full lifecycle integration
// ══════════════════════════════════════════════════════════════

describe("Active Memory Full Cycle", () => {
  let basePath: string;
  let engine: ActiveMemoryEngine;

  beforeEach(() => {
    basePath = createTempDir();
    engine = new ActiveMemoryEngine({ storageBasePath: basePath, dailySnapshot: false });
  });

  afterEach(async () => {
    await engine.shutdown();
    await rm(basePath, { recursive: true, force: true });
  });

  it("should complete a full memory lifecycle", async () => {
    await engine.initialize();

    const step0 = await engine.beforeStep("Tell me about pricing", 0);
    expect(step0.memories).toHaveLength(0);

    engine.proposeMemory("customer_fact", "Client has 50+ employees in manufacturing", "cust-42");

    await engine.afterRun({
      steps: 8, durationMs: 15000, sessionKey: "session-full-1", runId: "run-full-1",
    });

    const step1 = await engine.beforeStep("manufacturing employees", 0);
    expect(step1.memories.length).toBeGreaterThanOrEqual(1);
    expect(step1.memoryContext).toContain("manufacturing");
    expect(step1.memoryContext).toContain("cust-42");
  });

  it("should isolate memories by workspace", async () => {
    const engineA = new ActiveMemoryEngine({ storageBasePath: basePath, workspaceId: "workspace-a", dailySnapshot: false });
    const engineB = new ActiveMemoryEngine({ storageBasePath: basePath, workspaceId: "workspace-b", dailySnapshot: false });

    await engineA.initialize();
    await engineB.initialize();

    engineA.proposeMemory("fact", "Secret A", "cust-a");
    await engineA.afterRun({ steps: 3, durationMs: 6000, sessionKey: "sess-a" });

    const resultB = await engineB.beforeStep("Secret A", 0);
    expect(resultB.memories).toHaveLength(0);

    await engineA.shutdown();
    await engineB.shutdown();
  });
});
