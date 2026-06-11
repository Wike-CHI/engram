# Engram Architecture

## Overview

Engram is a layered memory system for AI agents. It separates storage backends from memory orchestration, making it adaptable to any agent framework.

```
┌──────────────────────────────────────────────────┐
│              Framework Adapters                  │
│  (GenericAdapter / StandaloneServer / OpenClaw)  │
├──────────────────────────────────────────────────┤
│              ActiveMemoryEngine                  │
│  Orchestrates L0-L4 memory lifecycle             │
├──────────────────────────────────────────────────┤
│              ActiveMemoryPlugin                  │
│  Plugin interface: hooks + tools + providers     │
├────────────┬─────────────────────┬───────────────┤
│ MemoryStore│  EmbeddingEngine    │ WorkingMemory │
│ (V1 JSONL) │  (OpenAI-compat)    │ Manager       │
├────────────┴─────────────────────┴───────────────┤
│           MemoryProvider Interface               │
├─────────────────────┬───────────────────────────┤
│ JsonlMemoryProvider │  SqliteMemoryProvider      │
│ (zero dependencies) │  (better-sqlite3 + FTS5)   │
└─────────────────────┴───────────────────────────┘
```

## Core Types

### Memory

```typescript
interface Memory {
  id: string;
  type: MemoryType;      // fact, preference, correction, customer_fact, etc.
  content: string;        // The factual content
  context: string;        // Surrounding context
  tags: string[];         // Searchable tags
  confidence: number;     // 0-1 confidence score
  source: string;         // Who/what created this memory
  customerId?: string;    // Optional customer scoping
  workspaceId?: string;   // Optional workspace isolation
  createdAt: string;      // ISO timestamp
  lastUsed: string;       // ISO timestamp (updated on access)
  accessCount: number;    // Number of times retrieved
  // ... plus optional fields: embedding, scope, tier, importance, etc.
}
```

### MemoryProvider Interface

```typescript
interface MemoryProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  addMemory(input: MemoryInput): Promise<Memory>;
  loadMemories(limit?: number): Promise<Memory[]>;
  searchMemories(query: string, limit?: number): Promise<Memory[]>;
  getRelevantMemories(tags: string[], limit?: number): Promise<Memory[]>;
  buildMemoryContext(currentTopic?: string): Promise<string>;
  getMemoryStats(): Promise<MemoryStats>;
  deleteMemory(id: string): Promise<boolean>;
  updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null>;
  touchMemory(id: string): Promise<void>;
}
```

### Plugin Interface

```typescript
interface Plugin {
  name: string;
  version: string;
  register(ctx: PluginContext): void | Promise<void>;
}

interface PluginContext {
  pluginId: string;
  registerHook(name, handler, priority?): void;
  registerTool(tool): void;
  registerMemoryProvider(provider): void;
  getConfig<T>(key): T | undefined;
  setConfig(key, value): void;
}
```

## Memory Lifecycle

```
Agent Run Starts
  │
  ├── before_step (L0) ──── Active memory search + injection
  │   ├── Search memories relevant to user message
  │   ├── Filter by workspace
  │   └── Inject formatted context into agent prompt
  │
  ├── Agent reasoning ───── Agent calls propose_memory tool (L1)
  │   └── Memories queued in pendingProposals buffer
  │
  ├── before_step (L2) ──── Conversation buffer collection
  │
  └── after_run ─────────── Post-run processing
      ├── L1: Save all pending proposals
      ├── L2: Background extract (if run > 5s)
      ├── L3: Save session bridge
      └── (L4: Daily snapshot runs on timer)
```

## Storage Backends

### JsonlMemoryProvider

- File-based JSONL storage
- Zero external dependencies
- Keyword search (with optional semantic via embedding function)
- Snapshot/restore support
- Auto-skip corrupted lines

### SqliteMemoryProvider

- SQLite with WAL mode
- FTS5 full-text search (BM25 ranking)
- Automatic FTS triggers on insert/update/delete
- LIKE fallback for simple queries
- `better-sqlite3` required as peer dependency

## Embedding Engine

The `EmbeddingEngine` generates vector embeddings using any OpenAI-compatible API:

- Configurable base URL and API key
- Single + batch embedding
- Configurable model (default: text-embedding-3-small)
- Factory function from environment variables
- Graceful degradation on failure

## Framework Adapters

Adapters map Engram's lifecycle hooks to host framework events:

| Adapter | Mount Method | Hook Mapping |
|---------|-------------|-------------|
| GenericAdapter | `mount(plugin)` + `runHooks()` | Manual via code |
| StandaloneServer | HTTP server | REST API endpoints |
| OpenClaw (future) | Plugin registration | Native PluginContext |
