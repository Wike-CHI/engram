# Engram API Reference

> **Version:** 0.1.0

---

## Package Exports

```typescript
import {
  // Types
  Memory, MemoryInput, MemoryPatch, MemoryStats,
  MemoryType, MemoryScope, MemoryTier,
  MemoryProvider, Plugin, PluginContext, PluginConfig,
  ToolDef, HookName, HookHandler,
  EngramLogger, EmbeddingFn,

  // Stores
  MemoryStore,

  // Providers
  JsonlMemoryProvider,
  SqliteMemoryProvider,

  // Embedding
  EmbeddingEngine, createEmbeddingEngineFromEnv,

  // Extraction
  extractFromSummary,

  // Working Memory
  WorkingMemoryManager,

  // Plugin
  ActiveMemoryPlugin,

  // Engine
  ActiveMemoryEngine,

  // Adapters
  GenericAdapter,
  StandaloneServer,

  // Hook constants
  HOOK_META,
} from "engram";
```

---

## MemoryProvider Interface

All storage backends implement `MemoryProvider`:

### `addMemory(input: MemoryInput): Promise<Memory>`
Persist a new memory. Auto-generates `id`, `createdAt`, `lastUsed`, `accessCount`.

### `loadMemories(limit?: number): Promise<Memory[]>`
Load recent memories, ordered by `lastUsed DESC`. Default limit: 50.

### `searchMemories(query: string, limit?: number): Promise<Memory[]>`
Search by text query. SqliteMemoryProvider uses FTS5 BM25; JsonlMemoryProvider uses word-level keyword matching. Falls back gracefully on FTS5 failure.

### `getRelevantMemories(tags: string[], limit?: number): Promise<Memory[]>`
Find memories by tag overlap, scored by relevance.

### `buildMemoryContext(currentTopic?: string): Promise<string>`
Build a formatted string for system prompt injection. Filters by topic if provided.

### `getMemoryStats(): Promise<MemoryStats>`
Returns `{ total, byType, byCustomer?, avgImportance? }`.

### `deleteMemory(id: string): Promise<boolean>`
Delete by ID. Returns true if deleted.

### `updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null>`
Update specific fields. Returns null if not found.

### `touchMemory(id: string): Promise<void>`
Increment `accessCount` and update `lastUsed`.

---

## JsonlMemoryProvider

```typescript
import { JsonlMemoryProvider } from "engram";

const provider = new JsonlMemoryProvider({
  basePath: "./data",           // Directory for memories.jsonl
  embeddingFn?: EmbeddingFn,   // Optional semantic search
  workspaceId?: string,         // Optional isolation
});
```

**Features:**
- Zero external dependencies
- JSONL append-only writes
- Word-level keyword search
- Semantic search via injected embedding function
- Daily snapshot with auto-cleanup (7 days)

---

## SqliteMemoryProvider

```typescript
import Database from "better-sqlite3";
import { SqliteMemoryProvider } from "engram";

const provider = new SqliteMemoryProvider({
  dbPath: "./engram.db",        // SQLite database path
  Database,                     // better-sqlite3 constructor
});
```

**Features:**
- FTS5 full-text search with BM25 ranking
- WAL mode for concurrent reads
- Automatic FTS triggers on insert/update/delete
- LIKE fallback on FTS5 failure
- Native backup via `createSnapshot()`

**Dependency:** `better-sqlite3` must be installed separately as a peer dependency.

---

## ActiveMemoryPlugin

```typescript
import { ActiveMemoryPlugin } from "engram";

const plugin = new ActiveMemoryPlugin({
  memoryProvider?: MemoryProvider,   // Default: JsonlMemoryProvider
  storageBasePath?: string,          // Default: "./engram-data"
  embeddingFn?: EmbeddingFn,
  activeMemoryLimit?: number,        // Default: 5
  workspaceId?: string,              // Default: "default"
  autoExtract?: boolean,             // Default: true
  llmCall?: (prompt: string) => Promise<string>,  // For L2 extraction
  sessionBridge?: boolean,           // Default: true
  dailySnapshot?: boolean,           // Default: true
});
```

Register with a host framework:

```typescript
const ctx: PluginContext = {
  pluginId: "my-app",
  registerHook(name, handler, priority) { /* ... */ },
  registerTool(tool) { /* ... */ },
  registerMemoryProvider(provider) { /* ... */ },
  getConfig: (key) => undefined,
  setConfig: () => {},
};
await plugin.register(ctx);
```

**Registered hooks:**
| Hook | Pri | Behavior |
|------|-----|----------|
| `before_step` | 10 | L0 active memory search |
| `before_step` | 50 | L2 conversation collection |
| `before_step` | 60 | L3 session bridge injection |
| `after_run` | 10 | L1 proposal save + L2 extract + L3 bridge |

**Registered tools:**
- `propose_memory` — Agent-callable. Parameters: `type` (string, enum), `content` (string), `customerId` (optional string).

---

## ActiveMemoryEngine

```typescript
import { ActiveMemoryEngine } from "engram";

const engine = new ActiveMemoryEngine({
  storageBasePath?: string,
  embeddingFn?: EmbeddingFn | null,
  workspaceId?: string,
  activeMemoryLimit?: number,
  llmCall?: (prompt: string) => Promise<string>,
});
await engine.initialize();
```

### `beforeStep(userMessage: string, stepIndex: number): Promise<BeforeStepResult>`
Process before an agent step:
- Returns `{ memories, memoryContext, sessionBridges }`
- `memoryContext` is a formatted string ready for system prompt injection

### `afterRun(completion: RunCompletion): Promise<void>`
Process after a run:
- Saves pending proposals (L1)
- Background extraction (L2, if configured and run > 5s)
- Session bridge save (L3)

### `proposeMemory(type, content, customerId?): { ok, message }`
Queue a memory proposal (L1). Call during agent reasoning.

### `getProvider(): MemoryProvider`
Access the underlying memory provider.

---

## EmbeddingEngine

```typescript
import { EmbeddingEngine, createEmbeddingEngineFromEnv } from "engram";

// Manual config
const engine = new EmbeddingEngine({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});
const embedding = await engine.embed("text to embed");

// From environment (ENGRAM_EMBEDDING_* or OPENAI_*)
const engine2 = createEmbeddingEngineFromEnv();
```

---

## WorkingMemoryManager

```typescript
import { WorkingMemoryManager } from "engram";

const wmm = new WorkingMemoryManager();
const wm = wmm.init("run-1", "Research competitor pricing", ["Find prices", "Compare"]);
wmm.recordStep("run-1", 1, "Found pricing page", ["web_search"], "success");
wmm.addFinding("run-1", "customer_insight", "Customer prefers email", 1);

// Check for goal drift
const drift = wmm.checkDrift("run-1");
if (drift.drifting) {
  console.log(drift.correction);
}

// Generate summary for prompt injection
const summary = wmm.generateSummary("run-1");
```

---

## StandaloneServer

```typescript
import { StandaloneServer } from "engram";

const server = new StandaloneServer({
  port: 3456,
  host: "localhost",
  apiKey: "optional-auth-key",
});
await server.start();

// API endpoints:
// GET  /health
// GET  /memories?limit=20
// POST /memories
// GET  /memories/search?q=&limit=
// GET  /memories/context?topic=
// DELETE /memories/:id
// GET  /stats
// POST /memories/propose
// POST /hooks/before_step
// POST /hooks/after_run
```

---

## GenericAdapter

```typescript
import { GenericAdapter, ActiveMemoryPlugin } from "engram";

const adapter = new GenericAdapter({
  onBeforeStep(memories, bridges) {
    return "custom context string";
  },
  onAfterRun(result) {
    console.log(`Run completed: ${result.steps} steps`);
  },
});

await adapter.mount(new ActiveMemoryPlugin({ storageBasePath: "./data" }));

// In agent loop:
await adapter.runHooks("before_step", { userMessage, step: 0 });
// ... agent reasoning ...
await adapter.runHooks("after_run", { steps, durationMs });

console.log(adapter.getProvider());    // Registered MemoryProvider
console.log(adapter.getTools());       // Registered tools
```
