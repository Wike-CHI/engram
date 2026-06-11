// Engram — Plugin Types
// Framework-agnostic plugin interface (ported from holo-desktop pluginTypes.ts)
// Any agent framework can implement PluginContext to host engram.

import type { Memory, MemoryInput, MemoryStats, MemoryPatch } from "./memory";

// ═══════════════════════════════════════════
// MemoryProvider — Pluggable storage backend
// ═══════════════════════════════════════════

export interface MemoryProvider {
  readonly name: string;

  /** Check if provider is ready (config, credentials, etc.) */
  isAvailable(): Promise<boolean>;

  /** One-time initialization (called during plugin startup) */
  initialize(): Promise<void>;

  /** Clean shutdown (called during plugin teardown) */
  shutdown(): Promise<void>;

  /** Persist a memory entry */
  addMemory(input: MemoryInput): Promise<Memory>;

  /** Load recent memories, newest first */
  loadMemories(limit?: number): Promise<Memory[]>;

  /** Search memories by text query (semantic-first, keyword fallback) */
  searchMemories(query: string, limit?: number): Promise<Memory[]>;

  /** Get relevant memories by tags (scored by confidence + recency) */
  getRelevantMemories(tags: string[], limit?: number): Promise<Memory[]>;

  /** Build a formatted string of relevant memories for system prompt injection */
  buildMemoryContext(currentTopic?: string): Promise<string>;

  /** Get storage statistics */
  getMemoryStats(): Promise<MemoryStats>;

  /** Delete a memory by id */
  deleteMemory(id: string): Promise<boolean>;

  /** Update specific fields of a memory entry */
  updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null>;

  /** Update lastUsed timestamp (called when memory is retrieved) */
  touchMemory(id: string): Promise<void>;
}

// ═══════════════════════════════════════════
// Hook — Lifecycle event types
// ═══════════════════════════════════════════

export type HookName = "before_step" | "after_step" | "after_run" | "on_error";

/**
 * Handler for lifecycle hooks.
 * - "before_step": called before each agent step — can inject context messages
 * - "after_step": called after each agent step — for per-step logging/analytics
 * - "after_run": called when an agent run completes — for extraction/cleanup
 * - "on_error": called when an agent run errors — for error logging/persistence
 */
export type HookHandler = (context: Record<string, unknown>) => void | Promise<void>;

export type HookExecutionMode = "sequential" | "parallel";

// ═══════════════════════════════════════════
// Tool — Agent-callable tool definition
// ═══════════════════════════════════════════

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  parallelSafe?: boolean;
  needsApproval?: boolean;
}

// ═══════════════════════════════════════════
// PluginContext — Hosted by the consumer framework
// ═══════════════════════════════════════════

export interface PluginConfig {
  /** Memory provider (defaults to JsonlMemoryProvider) */
  memoryProvider?: MemoryProvider;

  /** Base path for file-based storage (overridable) */
  storageBasePath?: string;

  /** Workspace ID for memory isolation */
  workspaceId?: string;

  /** Maximum memories to inject per before_step (default: 5) */
  activeMemoryLimit?: number;

  /** Minimum confidence for memory retrieval (default: 0.3) */
  minConfidence?: number;

  /** Enable automatic background memory extraction (default: true) */
  autoExtract?: boolean;

  /** Enable session bridging for cross-session continuity (default: true) */
  sessionBridge?: boolean;
}

// ═══════════════════════════════════════════
// Plugin — The main plugin interface
// ═══════════════════════════════════════════

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  register(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  pluginId: string;

  /** Register a lifecycle hook */
  registerHook(name: HookName, handler: HookHandler, priority?: number): void;

  /** Register an agent-callable tool */
  registerTool(tool: ToolDef): void;

  /** Register a memory provider (replaces default) */
  registerMemoryProvider(provider: MemoryProvider): void;

  /** Get/Set plugin-scoped config */
  getConfig<T>(key: string): T | undefined;
  setConfig(key: string, value: unknown): void;
}
