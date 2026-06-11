# Engram

> **Framework-agnostic active memory for AI agents.**  
> Automatic memory extraction, semantic search, session bridging, and pluggable storage — works with any agent framework.

[![npm version](https://img.shields.io/npm/v/engram)](https://www.npmjs.com/package/engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Test Status](https://github.com/holo-ai/engram/actions/workflows/ci.yml/badge.svg)](https://github.com/holo-ai/engram/actions)

---

## Why Engram?

AI agents forget. Engram gives them **durable memory**:

- **Active Memory** — automatically retrieves relevant memories before each agent step
- **Automatic Extraction** — extracts valuable info from conversations after each run
- **Pluggable Backends** — JSONL (zero deps) or SQLite+FTS5 (for production)
- **Framework Agnostic** — use with OpenClaw, LangChain, CrewAI, or your own runtime
- **Zero Config** — works out of the box, no Docker, no external services

## Quick Start

```bash
npm install engram
```

### Use the Active Memory Engine

```typescript
import { ActiveMemoryEngine } from "engram";

const engine = new ActiveMemoryEngine({ storageBasePath: "./memory-data" });
await engine.initialize();

// Agent proposes a memory
engine.proposeMemory("preference", "Customer prefers email over phone", "cust-42");

// After run completes — auto-save proposals
await engine.afterRun({ steps: 8, durationMs: 15000, sessionKey: "session-1" });

// Before next run — auto-retrieve relevant memories
const result = await engine.beforeStep("email communication", 0);
console.log(result.memoryContext);
// [Engram — 相关记忆]
// - [preference] [cust-42] Customer prefers email over phone
```

### Use a Memory Provider Directly

```typescript
import { JsonlMemoryProvider } from "engram";

const provider = new JsonlMemoryProvider({ basePath: "./memory-data" });
await provider.initialize();

await provider.addMemory({
  type: "fact",
  content: "Engram supports plugin architecture",
  tags: ["architecture", "engram"],
  confidence: 0.9,
  source: "developer",
});

const results = await provider.searchMemories("plugin architecture");
console.log(results[0].content); // "Engram supports plugin architecture"
await provider.shutdown();
```

## Memory Providers

| Provider | Storage | Dependencies | Best For |
|----------|---------|-------------|----------|
| `JsonlMemoryProvider` | JSONL file | None | Development, personal use |
| `SqliteMemoryProvider` | SQLite + FTS5 | `better-sqlite3` | Production, full-text search |

```typescript
// SQLite provider (requires better-sqlite3)
import Database from "better-sqlite3";
import { SqliteMemoryProvider } from "engram";

const provider = new SqliteMemoryProvider({
  dbPath: "./engram.db",
  Database,
});
await provider.initialize();
```

## Active Memory Layers

Engram's active memory system operates in four layers:

| Layer | Name | Trigger | What it does |
|-------|------|---------|-------------|
| **L0** | Active Retrieval | `before_step` | Searches memories relevant to user message, injects into context |
| **L1** | Agent Propose | `propose_memory` tool | Main LLM proposes memories during conversation |
| **L2** | Background Extract | `after_run` | LLM extracts memories from conversation summaries (dedup-aware) |
| **L3** | Session Bridge | `before_step` + `after_run` | Saves session summaries, injects previous context on new sessions |
| **L4** | Daily Snapshot | Timer | Creates timestamped backup, auto-cleans old snapshots |

## Plugin Architecture

Engram can be integrated into any agent framework via a lightweight plugin system:

```typescript
import { ActiveMemoryPlugin, GenericAdapter } from "engram";

const plugin = new ActiveMemoryPlugin({ storageBasePath: "./data" });
const adapter = new GenericAdapter();
await adapter.mount(plugin);

// In your agent loop:
await adapter.runHooks("before_step", { userMessage, step: 0 });
// ... agent reasoning ...
await adapter.runHooks("after_run", { steps, durationMs });
```

**Available adapters:**
- `GenericAdapter` — callback-based hooks for any custom runtime
- `StandaloneServer` — HTTP server (sidecar deployment)
- OpenClaw / LangChain adapters — coming soon

## Standalone HTTP Server

Run Engram as a standalone sidecar:

```typescript
import { StandaloneServer } from "engram";

const server = new StandaloneServer({ port: 3456 });
await server.start();
// API available at http://localhost:3456
```

Endpoints:
- `GET /health` — Health check
- `GET /memories` — List memories
- `POST /memories` — Add a memory
- `GET /memories/search?q=` — Search memories
- `GET /stats` — Memory statistics
- `POST /memories/propose` — Propose a memory

## API Overview

| Export | Category | Description |
|--------|----------|-------------|
| `MemoryStore` | Store | V1 JSONL-based memory store |
| `JsonlMemoryProvider` | Provider | JSONL MemoryProvider (zero deps) |
| `SqliteMemoryProvider` | Provider | SQLite+FTS5 MemoryProvider |
| `ActiveMemoryPlugin` | Plugin | Full L0-L4 active memory plugin |
| `ActiveMemoryEngine` | Engine | Direct orchestration API |
| `GenericAdapter` | Adapter | Callback-based framework adapter |
| `StandaloneServer` | Adapter | HTTP server for sidecar deployment |
| `EmbeddingEngine` | Embedding | OpenAI-compatible embedding generation |
| `WorkingMemoryManager` | Working | Task progress tracking + drift detection |
| `extractFromSummary` | Extraction | LLM-powered memory extraction |

## Examples

See the [examples](./examples) directory:

- [Basic Usage](./examples/basic-usage.ts) — Core API walkthrough
- [HTTP Server](./examples/http-server.ts) — Sidecar deployment

## Framework Integration

Engram's `Plugin` interface uses three lifecycle hooks:

| Hook | When | Purpose |
|------|------|---------|
| `before_step` | Before each agent reasoning step | Inject relevant memories |
| `after_run` | After a complete agent run | Save proposals, extract, bridge |
| `on_error` | On agent error | Persist error context |

Framework adapters map these hooks to the host framework's event system.

## Roadmap

- [x] Phase 1: Core types + MemoryStore V1
- [x] Phase 2: Active Memory Plugin (L0-L4)
- [x] Phase 3: SQLite+FTS5 Provider
- [x] Phase 4: Framework adapters + HTTP server
- [ ] Phase 5: Documentation + community
- [ ] Phase 6: npm publish + CI/CD
- [ ] OpenClaw adapter
- [ ] LangChain adapter
- [ ] ChromaDB Provider
- [ ] Memory dream/consolidation service

## License

MIT

---

Built for agents that remember.
