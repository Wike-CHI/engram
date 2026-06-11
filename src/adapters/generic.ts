// Engram — Generic Adapter
// For integrating Engram into any custom agent framework.
// Provides callback-based hooks and a simple API surface.

import type { Plugin, PluginContext, HookName, HookHandler, MemoryProvider } from "../types/pluginTypes";
import type { GenericAdapterConfig } from "./types";

const noop = () => {};

/**
 * GenericAdapter — mounts an Engram plugin into any custom runtime.
 *
 * ## Usage
 * ```typescript
 * import { ActiveMemoryPlugin, GenericAdapter } from "engram";
 *
 * const adapter = new GenericAdapter();
 * const plugin = new ActiveMemoryPlugin({ storageBasePath: "./data" });
 * await adapter.mount(plugin);
 *
 * // Use the adapter in your agent loop
 * const context = { userMessage: "Hello" };
 * await adapter.runHooks("before_step", context);
 *
 * // Access the registered memory provider
 * const provider = adapter.getProvider();
 * ```
 */
export class GenericAdapter {
  readonly framework = "generic";
  private plugin: Plugin | null = null;
  private context: PluginContext | null = null;
  private provider: MemoryProvider | null = null;
  private hooks = new Map<HookName, Array<{ handler: HookHandler; priority: number }>>();
  private config: Required<GenericAdapterConfig>;

  constructor(config: GenericAdapterConfig = {}) {
    this.config = {
      onBeforeStep: config.onBeforeStep ?? noop,
      onAfterRun: config.onAfterRun ?? noop,
      onMemoryProposed: config.onMemoryProposed ?? noop,
    };
  }

  /**
   * Mount an Engram plugin.
   * The adapter creates a PluginContext and passes it to the plugin's register() method.
   */
  async mount(plugin: Plugin): Promise<void> {
    this.plugin = plugin;

    this.context = {
      pluginId: "engram-generic",
      registerHook: (name: HookName, handler: HookHandler, priority = 0) => {
        if (!this.hooks.has(name)) this.hooks.set(name, []);
        this.hooks.get(name)!.push({ handler, priority });
        this.hooks.get(name)!.sort((a, b) => a.priority - b.priority);
      },
      registerTool: (tool) => {
        this.tools.push(tool);
      },
      registerMemoryProvider: (provider) => {
        this.provider = provider;
      },
      getConfig: <T>(key: string) => undefined as T | undefined,
      setConfig: () => {},
    };

    await plugin.register(this.context);
  }

  /** Unmount the plugin */
  async unmount(): Promise<void> {
    this.hooks.clear();
    this.tools = [];
    this.plugin = null;
    this.context = null;
  }

  /**
   * Run all hooks registered for the given hook name.
   * Each handler is called sequentially in priority order.
   * The context object is passed through and modified by handlers.
   */
  async runHooks(name: HookName, context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handlers = this.hooks.get(name) ?? [];
    for (const { handler } of handlers) {
      try {
        await handler(context);
      } catch {
        // isolate hook failures — one hook should not break others
      }
    }

    // Call user callback after hooks
    if (name === "before_step") {
      const memories = (context._engramMemories as string[]) ?? [];
      const bridges = (context._engramSessionBridge as string[]) ?? [];
      const result = this.config.onBeforeStep(memories, bridges);
      if (result) context._engramMemoryContext = result;
    }
    if (name === "after_run") {
      this.config.onAfterRun({
        steps: (context.steps as number) ?? 0,
        durationMs: (context.durationMs as number) ?? 0,
      });
    }

    return context;
  }

  /** Get the registered memory provider */
  getProvider(): MemoryProvider | null {
    return this.provider;
  }

  /** Get registered tools */
  getTools(): Array<{ name: string }> {
    return [...this.tools];
  }

  private tools: Array<{ name: string }> = [];
}
