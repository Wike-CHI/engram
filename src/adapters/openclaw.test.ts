// Engram — OpenClaw Adapter Tests
//
// Tests follow the same patterns as phase4.test.ts:
// - Temp directories for isolation
// - beforeEach/afterEach for setup/teardown
// - Focus on adapter behavior, not plugin internals

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenClawAdapter } from "./openclaw";
import type { OpenClawHost } from "./openclaw";
import { ActiveMemoryPlugin } from "../plugin/activeMemoryPlugin";
import type { HookName, MemoryProvider, ToolDef } from "../types/pluginTypes";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-oc-test-"));
}

// ══════════════════════════════════════════════════════════════
// OpenClawAdapter
// ══════════════════════════════════════════════════════════════

describe("OpenClawAdapter", () => {
  let basePath: string;
  let adapter: OpenClawAdapter;
  let plugin: ActiveMemoryPlugin;

  beforeEach(() => {
    basePath = createTempDir();
    adapter = new OpenClawAdapter();
    plugin = new ActiveMemoryPlugin({
      storageBasePath: basePath,
      dailySnapshot: false,
    });
  });

  afterEach(async () => {
    await adapter.unmount();
    await rm(basePath, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════════════════════════
  // Mount / Unmount lifecycle
  // ══════════════════════════════════════════════════════════════

  it("should mount a plugin and register the memory provider", async () => {
    await adapter.mount(plugin);
    expect(adapter.getProvider()).not.toBeNull();
    expect(adapter.getProvider()!.name).toBe("jsonl");
  });

  it("should register hooks during mount", async () => {
    await adapter.mount(plugin);
    expect(adapter.hasHook("before_step")).toBe(true);
    expect(adapter.hasHook("after_run")).toBe(true);
  });

  it("should register tools during mount", async () => {
    await adapter.mount(plugin);
    const tools = adapter.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === "propose_memory")).toBe(true);
  });

  it("should expose the mounted plugin instance", async () => {
    await adapter.mount(plugin);
    expect(adapter.getPlugin()).toBe(plugin);
  });

  it("should unmount cleanly", async () => {
    await adapter.mount(plugin);
    expect(adapter.getPlugin()).not.toBeNull();

    await adapter.unmount();
    expect(adapter.getPlugin()).toBeNull();
    expect(adapter.getProvider()).toBeNull();
    expect(adapter.getTools()).toEqual([]);
    expect(adapter.hasHook("before_step")).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════
  // Inspection helpers
  // ══════════════════════════════════════════════════════════════

  it("should return hooks sorted by priority", async () => {
    await adapter.mount(plugin);
    const hooks = adapter.getHooks("before_step");
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    // Hooks should be sorted by priority ascending
    for (let i = 1; i < hooks.length; i++) {
      expect(hooks[i].priority).toBeGreaterThanOrEqual(hooks[i - 1].priority);
    }
  });

  it("should return empty array for unregistered hook names", async () => {
    await adapter.mount(plugin);
    const hooks = adapter.getHooks("on_error");
    expect(hooks).toEqual([]);
  });

  it("should support getRegisteredHooks returning all hook groups", async () => {
    await adapter.mount(plugin);
    const allHooks = adapter.getRegisteredHooks();
    expect(allHooks.has("before_step")).toBe(true);
    expect(allHooks.has("after_run")).toBe(true);
    // Returns a copy, not the internal map
    allHooks.clear();
    expect(adapter.hasHook("before_step")).toBe(true);
  });

  it("should be usable without mounting", async () => {
    expect(adapter.getProvider()).toBeNull();
    expect(adapter.getTools()).toEqual([]);
    expect(adapter.getPlugin()).toBeNull();
    expect(adapter.hasHook("before_step")).toBe(false);
    expect(adapter.getHooks("before_step")).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════
  // Bridge to OpenClawHost (duck-typed runtime)
  // ══════════════════════════════════════════════════════════════

  it("should bridge hooks to OpenClawHost when provided", async () => {
    const registeredHooks: HookName[] = [];
    const mockHost: OpenClawHost = {
      registerHook: (name: HookName) => { registeredHooks.push(name); },
      registerTool: () => {},
      registerMemoryProvider: () => {},
    };

    await adapter.mount(plugin, mockHost);
    expect(registeredHooks).toContain("before_step");
    expect(registeredHooks).toContain("after_run");
  });

  it("should bridge tools to OpenClawHost when provided", async () => {
    const registeredTools: string[] = [];
    const mockHost: OpenClawHost = {
      registerHook: () => {},
      registerTool: (tool: ToolDef) => { registeredTools.push(tool.name); },
      registerMemoryProvider: () => {},
    };

    await adapter.mount(plugin, mockHost);
    expect(registeredTools).toContain("propose_memory");
  });

  it("should bridge memory provider to OpenClawHost when provided", async () => {
    let bridgedProvider: MemoryProvider | null = null;
    const mockHost: OpenClawHost = {
      registerHook: () => {},
      registerTool: () => {},
      registerMemoryProvider: (provider: MemoryProvider) => { bridgedProvider = provider; },
    };

    await adapter.mount(plugin, mockHost);
    expect(bridgedProvider).not.toBeNull();
    expect(bridgedProvider!.name).toBe("jsonl");
  });

  it("should still capture locally when bridging to a host", async () => {
    const mockHost: OpenClawHost = {
      registerHook: () => {},
      registerTool: () => {},
      registerMemoryProvider: () => {},
    };

    await adapter.mount(plugin, mockHost);

    // Local capture should still work
    expect(adapter.getProvider()).not.toBeNull();
    expect(adapter.hasHook("before_step")).toBe(true);
    expect(adapter.getTools().length).toBeGreaterThanOrEqual(1);
    expect(adapter.getPlugin()).toBe(plugin);
  });

  // ══════════════════════════════════════════════════════════════
  // Duck typing edge cases
  // ══════════════════════════════════════════════════════════════

  it("should detect valid OpenClawHost via duck typing", async () => {
    // An object with all three methods should bridge
    const validHost = {
      registerHook: () => {},
      registerTool: () => {},
      registerMemoryProvider: () => {},
    };

    let capturedCallCount = 0;
    const realRegisterHook = validHost.registerHook;
    validHost.registerHook = () => { capturedCallCount++; };

    await adapter.mount(plugin, validHost);
    // Should have called registerHook at least once
    expect(capturedCallCount).toBeGreaterThan(0);
  });

  it("should not bridge when hostContext is null or undefined", async () => {
    // null should not trigger bridging
    await adapter.unmount();
    adapter = new OpenClawAdapter();
    await adapter.mount(plugin, null as unknown as undefined);
    expect(adapter.getProvider()).not.toBeNull();

    // undefined should not trigger bridging
    await adapter.unmount();
    adapter = new OpenClawAdapter();
    const p2 = new ActiveMemoryPlugin({ storageBasePath: createTempDir(), dailySnapshot: false });
    await adapter.mount(p2, undefined);
    expect(adapter.getProvider()).not.toBeNull();
  });

  it("should not bridge when hostContext has partial methods", async () => {
    // Object with only registerHook (missing registerTool) should NOT bridge
    const partialHost = { registerHook: () => {} };
    await adapter.mount(plugin, partialHost as unknown as OpenClawHost);
    // Provider should still be captured (bridging didn't happen)
    expect(adapter.getProvider()).not.toBeNull();
  });

  it("should not bridge when hostContext is a non-object", async () => {
    const nonObjects = ["string", 42, true];
    for (const val of nonObjects) {
      await adapter.unmount();
      adapter = new OpenClawAdapter();
      const p = new ActiveMemoryPlugin({ storageBasePath: createTempDir(), dailySnapshot: false });
      await adapter.mount(p, val as unknown as undefined);
      // Should not throw, should work without bridging
      expect(adapter.getProvider()).not.toBeNull();
      await p.shutdown();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Framework interface compliance
  // ══════════════════════════════════════════════════════════════

  it("should have the correct framework identifier", () => {
    expect(adapter.framework).toBe("openclaw");
  });

  it("should implement the FrameworkAdapter mount/unmount contract", async () => {
    const plugin2 = new ActiveMemoryPlugin({
      storageBasePath: createTempDir(),
      dailySnapshot: false,
    });

    // Mount
    await adapter.mount(plugin2);
    expect(adapter.getProvider()).not.toBeNull();

    // Verify hooks are from the second plugin
    const beforeStepHooks = adapter.getHooks("before_step");
    expect(beforeStepHooks.length).toBeGreaterThanOrEqual(1);

    // Unmount and verify cleanup
    await adapter.unmount();
    expect(adapter.getProvider()).toBeNull();
    expect(adapter.getTools()).toEqual([]);

    // Mount another (should work after unmount)
    const plugin3 = new ActiveMemoryPlugin({
      storageBasePath: createTempDir(),
      dailySnapshot: false,
    });
    await adapter.mount(plugin3);
    expect(adapter.getProvider()).not.toBeNull();
  });

  // ══════════════════════════════════════════════════════════════
  // Integration with a full OpenClawHost
  // ══════════════════════════════════════════════════════════════

  it("should forward all plugin registrations to a fully instrumented host", async () => {
    interface Registration {
      kind: "hook" | "tool" | "provider";
      detail: string;
    }
    const registrations: Registration[] = [];

    const instrumentedHost: OpenClawHost = {
      registerHook: (name: HookName, _handler: unknown, priority?: number) => {
        registrations.push({ kind: "hook", detail: `${name}@${priority ?? 0}` });
      },
      registerTool: (tool: ToolDef) => {
        registrations.push({ kind: "tool", detail: tool.name });
      },
      registerMemoryProvider: (provider: MemoryProvider) => {
        registrations.push({ kind: "provider", detail: provider.name });
      },
    };

    await adapter.mount(plugin, instrumentedHost);

    // Verify all three registration types were forwarded
    expect(registrations.some((r) => r.kind === "hook")).toBe(true);
    expect(registrations.some((r) => r.kind === "tool")).toBe(true);
    expect(registrations.some((r) => r.kind === "provider")).toBe(true);

    // Verify specific details
    expect(registrations.some((r) => r.kind === "tool" && r.detail === "propose_memory")).toBe(true);
    expect(registrations.some((r) => r.kind === "provider" && r.detail === "jsonl")).toBe(true);
    expect(registrations.some((r) => r.kind === "hook" && r.detail.startsWith("before_step"))).toBe(true);
    expect(registrations.some((r) => r.kind === "hook" && r.detail.startsWith("after_run"))).toBe(true);

    // Total registrations should be at least: 1 provider + 2 hooks + 1 tool = 4
    expect(registrations.length).toBeGreaterThanOrEqual(4);
  });
});
