// Engram — OpenClaw Framework Adapter
// Bridges an Engram Plugin into the OpenClaw plugin architecture.
// OpenClaw uses the same Plugin/PluginContext pattern as Engram,
// so the adapter simply calls plugin.register() with a context
// that bridges to the OpenClaw runtime.
//
// ## OpenClaw Plugin Architecture (for reference)
// OpenClaw plugins export a `register(ctx: PluginContext)` function.
// PluginContext provides:
//   registerHook(name, handler, priority)  — lifecycle hooks
//   registerTool(tool)                      — agent-callable tools
//   registerMemoryProvider(provider)         — memory storage backend
//   getConfig<T>(key), setConfig(key, value) — plugin-scoped config
//
// Engram's Plugin interface mirrors this design exactly — the adapter
// creates a bridge PluginContext and delegates to the OpenClaw runtime.

import type { Plugin, PluginContext, HookName, HookHandler, MemoryProvider, ToolDef } from "../types/pluginTypes";
import type { FrameworkAdapter } from "./types";

/**
 * OpenClawHost — duck-typed interface for an OpenClaw runtime.
 *
 * OpenClaw is NOT installed as a dependency of Engram, so the adapter
 * uses duck typing to bridge to a running OpenClaw instance.
 * Any object that provides the three registration methods is accepted.
 *
 * ## Usage
 * ```typescript
 * class MyOpenClawRuntime implements OpenClawHost {
 *   registerHook(name, handler, priority) { /* forward to hookRegistry *\/ }
 *   registerTool(tool)                     { /* forward to toolRegistry *\/ }
 *   registerMemoryProvider(provider)       { /* set as active provider *\/ }
 * }
 *
 * const adapter = new OpenClawAdapter();
 * await adapter.mount(plugin, myOpenClawRuntime);
 * ```
 */
export interface OpenClawHost {
  /** Register a lifecycle hook with the OpenClaw runtime */
  registerHook(name: HookName, handler: HookHandler, priority?: number): void;

  /** Register an agent-callable tool with the OpenClaw runtime */
  registerTool(tool: ToolDef): void;

  /** Register a memory provider with the OpenClaw runtime */
  registerMemoryProvider(provider: MemoryProvider): void;
}

/**
 * OpenClawAdapter — mounts an Engram Plugin into OpenClaw.
 *
 * ## Overview
 * Engram and OpenClaw share the same Plugin/PluginContext design pattern.
 * The adapter creates a bridge PluginContext that:
 *
 * 1. Captures hooks/tools/provider registered by the Engram plugin
 * 2. Forwards them to the OpenClaw runtime (if provided via hostContext)
 * 3. Exposes them via inspection helpers for testing and verification
 *
 * ## Usage with OpenClaw Runtime
 * ```typescript
 * import { ActiveMemoryPlugin, OpenClawAdapter } from "engram";
 *
 * const adapter = new OpenClawAdapter();
 * const plugin = new ActiveMemoryPlugin({ storageBasePath: "./data" });
 *
 * // Bridge to a running OpenClaw instance
 * await adapter.mount(plugin, myOpenClawRuntime);
 * ```
 *
 * ## Testing in Isolation
 * ```typescript
 * // Without hostContext, the adapter captures calls for verification
 * await adapter.mount(plugin);
 * const hooks = adapter.getRegisteredHooks();    // Map<HookName, Handler[]>
 * const tools = adapter.getTools();              // ToolDef[]
 * const provider = adapter.getProvider();         // MemoryProvider | null
 * ```
 *
 * ## Duck Typing
 * OpenClaw is NOT a dependency of Engram. The adapter uses duck typing
 * (the OpenClawHost interface) to avoid a hard dependency. Any object
 * matching the OpenClawHost shape (registerHook + registerTool +
 * registerMemoryProvider methods) works as the hostContext.
 *
 * ## Registration Flow
 * ```
 * ActiveMemoryPlugin.register(ctx)
 *   ├── ctx.registerMemoryProvider(provider)  → captured + bridged to host
 *   ├── ctx.registerHook("before_step", h, 10) → captured + bridged to host
 *   ├── ctx.registerHook("after_run", h, 10)   → captured + bridged to host
 *   └── ctx.registerTool(proposeMemoryTool)    → captured + bridged to host
 * ```
 */
export class OpenClawAdapter implements FrameworkAdapter {
  /** Framework identifier */
  readonly framework = "openclaw";

  private plugin: Plugin | null = null;
  private hooks = new Map<HookName, Array<{ handler: HookHandler; priority: number }>>();
  private tools: ToolDef[] = [];
  private provider: MemoryProvider | null = null;

  /**
   * Mount an Engram plugin into an OpenClaw runtime.
   *
   * @param plugin      - The Engram plugin to mount
   * @param hostContext - Optional OpenClaw runtime (duck-typed as OpenClawHost).
   *                      When provided, hooks/tools/provider are bridged to
   *                      the OpenClaw runtime. When omitted, they are only
   *                      captured locally for testing and verification.
   */
  async mount(plugin: Plugin, hostContext?: unknown): Promise<void> {
    this.plugin = plugin;

    // Duck-type check: does hostContext quack like an OpenClawHost?
    const host = this.isOpenClawHost(hostContext) ? hostContext : null;

    const ctx: PluginContext = {
      pluginId: `engram-${plugin.name}`,

      registerHook: (name: HookName, handler: HookHandler, priority = 0) => {
        // Capture locally for inspection
        if (!this.hooks.has(name)) this.hooks.set(name, []);
        this.hooks.get(name)!.push({ handler, priority });
        this.hooks.get(name)!.sort((a, b) => a.priority - b.priority);

        // Bridge to OpenClaw runtime if connected
        if (host) {
          host.registerHook(name, handler, priority);
        }
      },

      registerTool: (tool: ToolDef) => {
        // Capture locally for inspection
        this.tools.push(tool);

        // Bridge to OpenClaw runtime if connected
        if (host) {
          host.registerTool(tool);
        }
      },

      registerMemoryProvider: (provider: MemoryProvider) => {
        // Capture locally for inspection
        this.provider = provider;

        // Bridge to OpenClaw runtime if connected
        if (host) {
          host.registerMemoryProvider(provider);
        }
      },

      getConfig: <T>(_key: string) => undefined as T | undefined,

      setConfig: (_key: string, _value: unknown) => {
        // Configuration is managed by the plugin directly
      },
    };

    await plugin.register(ctx);
  }

  /**
   * Unmount the plugin and clean up.
   * Clears all captured hooks, tools, provider, and plugin references.
   */
  async unmount(): Promise<void> {
    this.hooks.clear();
    this.tools = [];
    this.provider = null;
    this.plugin = null;
  }

  // ══════════════════════════════════════════════════════════════
  // Inspection helpers (for testing, verification, and debugging)
  // ══════════════════════════════════════════════════════════════

  /**
   * Get all registered hooks grouped by hook name.
   *
   * @returns A map of hook name to array of handlers with priorities,
   *          sorted by priority ascending within each hook name.
   */
  getRegisteredHooks(): Map<HookName, Array<{ handler: HookHandler; priority: number }>> {
    return new Map(this.hooks);
  }

  /**
   * Get hooks registered for a specific lifecycle event.
   *
   * @param name - The hook name to query
   * @returns Array of handlers with priorities, or empty array if none
   *          registered for the given hook name.
   */
  getHooks(name: HookName): Array<{ handler: HookHandler; priority: number }> {
    return [...(this.hooks.get(name) ?? [])];
  }

  /**
   * Get all registered tools.
   *
   * @returns A copy of the registered ToolDef array.
   */
  getTools(): ToolDef[] {
    return [...this.tools];
  }

  /**
   * Get the registered memory provider, if any.
   *
   * @returns The memory provider, or null if none was registered.
   */
  getProvider(): MemoryProvider | null {
    return this.provider;
  }

  /**
   * Check if a specific hook type was registered.
   *
   * @param name - The hook name to check
   * @returns true if at least one handler is registered for the given hook name
   */
  hasHook(name: HookName): boolean {
    return (this.hooks.get(name)?.length ?? 0) > 0;
  }

  /**
   * Get the mounted plugin instance.
   *
   * @returns The plugin, or null if not mounted.
   */
  getPlugin(): Plugin | null {
    return this.plugin;
  }

  // ══════════════════════════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════════════════════════

  /**
   * Duck-type check: is the given value an OpenClawHost?
   *
   * Checks for the presence of registerHook, registerTool, and
   * registerMemoryProvider methods — the minimal surface required
   * to bridge an Engram plugin into an OpenClaw runtime.
   *
   * @param value - The value to check (typically the hostContext)
   * @returns true if the value matches the OpenClawHost shape
   */
  private isOpenClawHost(value: unknown): value is OpenClawHost {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.registerHook === "function" &&
      typeof obj.registerTool === "function" &&
      typeof obj.registerMemoryProvider === "function"
    );
  }
}
