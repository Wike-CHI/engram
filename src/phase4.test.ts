// Engram — Phase 4 测试：GenericAdapter + StandaloneServer

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GenericAdapter } from "./adapters/generic";
import { StandaloneServer } from "./adapters/standalone";
import { ActiveMemoryPlugin } from "./plugin/activeMemoryPlugin";
import { ActiveMemoryEngine } from "./core/activeMemoryEngine";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-p4-test-"));
}

// ══════════════════════════════════════════════════════════════
// GenericAdapter
// ══════════════════════════════════════════════════════════════

describe("GenericAdapter", () => {
  let basePath: string;
  let adapter: GenericAdapter;
  let plugin: ActiveMemoryPlugin;

  beforeEach(() => {
    basePath = createTempDir();
    adapter = new GenericAdapter();
    plugin = new ActiveMemoryPlugin({
      storageBasePath: basePath,
      dailySnapshot: false,
    });
  });

  afterEach(async () => {
    await adapter.unmount();
    await rm(basePath, { recursive: true, force: true });
  });

  it("should mount a plugin", async () => {
    await adapter.mount(plugin);
    expect(adapter.getProvider()).not.toBeNull();
    expect(adapter.getProvider()!.name).toBe("jsonl");
  });

  it("should register hooks from plugin", async () => {
    await adapter.mount(plugin);
    const ctx = { userMessage: "test", step: 0 };
    const result = await adapter.runHooks("before_step", ctx);

    // Hooks should have run without error
    expect(result).toBeDefined();
    expect(result.userMessage).toBe("test");
  });

  it("should register tools from plugin", async () => {
    await adapter.mount(plugin);
    const tools = adapter.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === "propose_memory")).toBe(true);
  });

  it("should execute before_step hooks via engine", async () => {
    await adapter.mount(plugin);
    const provider = adapter.getProvider()!;

    // Add a seed memory
    await provider.addMemory({
      type: "fact",
      content: "seed memory for testing",
      context: "",
      tags: ["test"],
      confidence: 0.9,
      source: "test",
    });

    const ctx = { userMessage: "seed memory", step: 0 };
    const result = await adapter.runHooks("before_step", ctx);

    // Should have retrieved the memory
    expect((result as any)._engramMemories).toBeDefined();
    expect((result as any)._engramMemories.length).toBeGreaterThanOrEqual(1);
  });

  it("should support mounting without plugin", async () => {
    // Just verify the adapter is usable
    expect(adapter.getProvider()).toBeNull();
    expect(adapter.getTools()).toEqual([]);
  });

  it("should call user callback on before_step", async () => {
    let callbackCalled = false;
    adapter = new GenericAdapter({
      onBeforeStep: (_memories, _bridges) => {
        callbackCalled = true;
        return "custom context";
      },
    });

    await adapter.mount(plugin);
    await adapter.runHooks("before_step", { userMessage: "test", step: 0 });

    expect(callbackCalled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// StandaloneServer
// ══════════════════════════════════════════════════════════════

describe("StandaloneServer", () => {
  let basePath: string;
  let server: StandaloneServer;

  beforeEach(() => {
    basePath = createTempDir();
  });

  afterEach(async () => {
    await server?.stop();
    await rm(basePath, { recursive: true, force: true });
  });

  it("should start and stop without error", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "" });
    await server.start();
    const engine = server.getEngine();
    expect(engine).toBeDefined();
    await server.stop();
  });

  it("should handle HTTP health request", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "" });
    await server.start();

    // Get the actual port
    const addr = (server as any).server?.address();
    const port = addr?.port ?? 3456;

    const resp = await fetch(`http://localhost:${port}/health`);
    const data = await resp.json();
    expect(data.status).toBe("ok");
  });

  it("should handle memories API", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "" });
    await server.start();
    const addr = (server as any).server?.address();
    const port = addr?.port ?? 3456;

    // POST a memory
    const addResp = await fetch(`http://localhost:${port}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fact",
        content: "API test memory",
        context: "",
        tags: ["api-test"],
        confidence: 0.9,
        source: "test",
      }),
    });
    expect(addResp.status).toBe(201);
    const addData = await addResp.json();
    expect(addData.memory.content).toBe("API test memory");

    // GET memories list
    const listResp = await fetch(`http://localhost:${port}/memories?limit=10`);
    const listData = await listResp.json();
    expect(listData.memories.length).toBeGreaterThanOrEqual(1);

    // Search
    const searchResp = await fetch(`http://localhost:${port}/memories/search?q=API+test`);
    const searchData = await searchResp.json();
    expect(searchData.results.length).toBeGreaterThanOrEqual(1);

    // Stats
    const statsResp = await fetch(`http://localhost:${port}/stats`);
    const statsData = await statsResp.json();
    expect(statsData.total).toBeGreaterThanOrEqual(1);
  });

  it("should reject unauthorized requests when apiKey is set", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "secret-key" });
    await server.start();
    const addr = (server as any).server?.address();
    const port = addr?.port ?? 3456;

    const resp = await fetch(`http://localhost:${port}/memories`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(resp.status).toBe(401);
  });

  it("should handle before_step and after_run hooks via API", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "" });
    await server.start();
    const addr = (server as any).server?.address();
    const port = addr?.port ?? 3456;

    // Propose a memory
    const proposeResp = await fetch(`http://localhost:${port}/memories/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fact", content: "hook test memory" }),
    });
    expect(proposeResp.status).toBe(200);

    // Verify it was saved
    const listResp = await fetch(`http://localhost:${port}/memories?limit=10`);
    const listData = await listResp.json();
    expect(listData.memories.some((m: any) => m.content === "hook test memory")).toBe(true);
  });

  it("should return 404 for unknown routes", async () => {
    server = new StandaloneServer({ port: 0, apiKey: "" });
    await server.start();
    const addr = (server as any).server?.address();
    const port = addr?.port ?? 3456;

    const resp = await fetch(`http://localhost:${port}/nonexistent`);
    expect(resp.status).toBe(404);
  });
});
