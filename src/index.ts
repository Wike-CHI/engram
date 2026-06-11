// Engram — framework-agnostic active memory for AI agents.
//
// ## Quick Start
// ```typescript
// import { JsonlMemoryProvider } from "engram";
//
// const provider = new JsonlMemoryProvider({ basePath: "./data" });
// await provider.initialize();
//
// // Store a memory
// await provider.addMemory({
//   type: "fact",
//   content: "User prefers email over phone",
//   context: "Discovered during cold call",
//   tags: ["preference", "communication"],
//   confidence: 0.8,
//   source: "agent",
// });
//
// // Search memories
// const results = await provider.searchMemories("email preference");
// ```

// ═══════════════════════════════════════════
// Types
// ═══════════════════════════════════════════

export type {
  Memory,
  MemoryInput,
  MemoryPatch,
  MemoryType,
  MemoryScope,
  MemoryTier,
  MemoryStats,
  MemorySearchOptions,
  EngramLogger,
} from "./types/memory";

export type {
  MemoryProvider,
  Plugin,
  PluginContext,
  PluginConfig,
  ToolDef,
  HookName,
  HookHandler,
  HookExecutionMode,
} from "./types/pluginTypes";

// ═══════════════════════════════════════════
// Stores
// ═══════════════════════════════════════════

export { MemoryStore } from "./stores/memoryStore";
export type { EmbeddingFn, Logger } from "./stores/memoryStore";

// ═══════════════════════════════════════════
// Providers
// ═══════════════════════════════════════════

export { JsonlMemoryProvider } from "./providers/jsonlProvider";
export type { JsonlMemoryProviderOptions } from "./providers/jsonlProvider";

export { SqliteMemoryProvider } from "./providers/sqliteMemoryProvider";
export type { SqliteProviderOptions } from "./providers/sqliteMemoryProvider";

// ═══════════════════════════════════════════
// Hook types
// ═══════════════════════════════════════════

export { HOOK_META } from "./types/hookTypes";

// ═══════════════════════════════════════════
// Embedding
// ═══════════════════════════════════════════

export { EmbeddingEngine, createEmbeddingEngineFromEnv } from "./embedding/embeddingEngine";
export type { EmbeddingConfig } from "./embedding/embeddingEngine";

// ═══════════════════════════════════════════
// Extraction
// ═══════════════════════════════════════════

export { extractFromSummary } from "./extraction/extractMemories";
export type { ExtractConfig, ExtractionResult } from "./extraction/extractMemories";

// ═══════════════════════════════════════════
// Working Memory
// ═══════════════════════════════════════════

export { WorkingMemoryManager } from "./working/workingMemoryManager";
export type {
  WorkingMemory,
  SubGoal,
  CompletedStep,
  Finding,
  DriftCheckResult,
  WorkingMemoryOptions,
} from "./working/workingMemoryManager";

// ═══════════════════════════════════════════
// Plugin
// ═══════════════════════════════════════════

export { ActiveMemoryPlugin } from "./plugin/activeMemoryPlugin";
export type { ActiveMemoryPluginOptions } from "./plugin/activeMemoryPlugin";

// ═══════════════════════════════════════════
// Core Engine
// ═══════════════════════════════════════════

export { ActiveMemoryEngine } from "./core/activeMemoryEngine";
export type { ActiveMemoryEngineOptions, BeforeStepResult, RunCompletion } from "./core/activeMemoryEngine";

// ═══════════════════════════════════════════
// Adapters
// ═══════════════════════════════════════════

export { GenericAdapter } from "./adapters/generic";
export { StandaloneServer } from "./adapters/standalone";
export type { FrameworkAdapter, GenericAdapterConfig, StandaloneServerConfig } from "./adapters/types";