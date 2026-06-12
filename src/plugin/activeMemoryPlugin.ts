// Engram — ActiveMemoryPlugin
// Framework-agnostic active memory plugin for AI agents.
// Layers:
//   L0: before_step — auto-search relevant memories, inject into context
//   L1: propose_memory tool — main LLM calls this to suggest memories
//   L2: after_run — background extraction from conversation summary
//   L3: session bridge — cross-session context continuity
//   L4: daily snapshot — timestamped backup, auto-cleanup old snapshots
//
// Ported from holo-desktop holoMemoryPlugin.ts — fully standalone.

import type { Plugin, PluginContext, PluginConfig, ToolDef, MemoryProvider } from "../types/pluginTypes";
import type { MemoryInput, EngramLogger } from "../types/memory";
import { JsonlMemoryProvider } from "../providers/jsonlProvider";
import { MemoryStore } from "../stores/memoryStore";
import type { EmbeddingFn } from "../stores/memoryStore";
import { extractFromSummary } from "../extraction/extractMemories";

// ══════════════════════════════════════════════════════════════
// ActiveMemoryPlugin — implements the Plugin interface
// ══════════════════════════════════════════════════════════════

export interface ActiveMemoryPluginOptions {
  /** Memory provider (defaults to JsonlMemoryProvider) */
  memoryProvider?: MemoryProvider;

  /** Base path for file-based storage (required if using default provider) */
  storageBasePath?: string;

  /** Optional embedding function for semantic search */
  embeddingFn?: EmbeddingFn | null;

  /** Maximum memories to inject per before_step (default: 5) */
  activeMemoryLimit?: number;

  /** Workspace ID for memory isolation */
  workspaceId?: string;

  /** Enable background extraction (default: true) — requires llmCall */
  autoExtract?: boolean;

  /** LLM call function for background extraction */
  llmCall?: (prompt: string) => Promise<string>;

  /** Enable session bridging (default: true) */
  sessionBridge?: boolean;

  /** Enable daily snapshots (default: true) */
  dailySnapshot?: boolean;

  /** Custom logger */
  logger?: EngramLogger;
}

export class ActiveMemoryPlugin implements Plugin {
  readonly name = "engram-active-memory";
  readonly version = "0.1.0";
  readonly description = "Active memory: automatic retrieval, extraction, session bridging, and backup";

  private options: Required<ActiveMemoryPluginOptions>;
  private provider!: MemoryProvider;
  private logger!: EngramLogger;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private conversationBuffer: Array<{ role: string; content: string }> = [];
  private pendingProposals: Array<{ type: string; content: string; customerId?: string }> = [];

  constructor(options: ActiveMemoryPluginOptions) {
    this.options = {
      memoryProvider: options.memoryProvider ?? new JsonlMemoryProvider({
        basePath: options.storageBasePath ?? "./engram-data",
        embeddingFn: options.embeddingFn ?? null,
      }),
      storageBasePath: options.storageBasePath ?? "./engram-data",
      embeddingFn: options.embeddingFn ?? null,
      activeMemoryLimit: options.activeMemoryLimit ?? 5,
      workspaceId: options.workspaceId ?? "default",
      autoExtract: options.autoExtract ?? true,
      llmCall: options.llmCall ?? (async () => "NONE"),
      sessionBridge: options.sessionBridge ?? true,
      dailySnapshot: options.dailySnapshot ?? true,
      logger: options.logger ?? {
        info: (msg) => console.log(`[engram:plugin] ${msg}`),
        warn: (msg) => console.warn(`[engram:plugin] ${msg}`),
        error: (msg) => console.error(`[engram:plugin] ${msg}`),
        debug: () => {},
      },
    };
    this.provider = this.options.memoryProvider;
    this.logger = this.options.logger;
  }

  // ══════════════════════════════════════════════════════════════
  // Plugin registration — called by the host framework
  // ══════════════════════════════════════════════════════════════

  async register(ctx: PluginContext): Promise<void> {
    // Initialize provider
    this.provider = this.options.memoryProvider;
    this.provider.initialize().catch((err) => {
      this.logger.error(`provider initialization failed: ${err}`);
    });

    // Register the memory provider with the host
    ctx.registerMemoryProvider(this.provider);

    // L0: before_step — active memory search and injection
    ctx.registerHook("before_step", async (context: Record<string, unknown>) => {
      const userMsg = context.userMessage as string | undefined;
      if (!userMsg) return;

      const memories = await this.provider.searchMemories(userMsg, this.options.activeMemoryLimit);
      if (memories.length === 0) return;

      // Filter by workspace
      const filtered = memories.filter(
        (m) => (m.workspaceId ?? "default") === this.options.workspaceId,
      );
      if (filtered.length === 0) return;

      const lines = filtered.map((m) => {
        const tag = m.customerId ? `[${m.customerId}] ` : "";
        return `- [${m.type}] ${tag}${m.content}`;
      });

      // The host framework reads this from context after hook execution
      context._engramMemories = lines;

      this.logger.info(`L0: injected ${filtered.length} relevant memories`);
    }, 10);

    // L2: before_step — collect conversation content for extraction
    ctx.registerHook("before_step", (context: Record<string, unknown>) => {
      const userMsg = context.userMessage as string | undefined;
      if (userMsg) {
        this.conversationBuffer.push({ role: "user", content: userMsg.slice(0, 500) });
        if (this.conversationBuffer.length > 20) {
          this.conversationBuffer.splice(0, this.conversationBuffer.length - 20);
        }
      }
    }, 50);

    // L3: before_step — session bridge (cross-session continuity)
    if (this.options.sessionBridge) {
      ctx.registerHook("before_step", async (context: Record<string, unknown>) => {
        const step = context.step as number | undefined;
        if (step !== 0 && step !== undefined) return;

        const bridges = await this.provider.searchMemories("session_bridge", 3);
        const recent = bridges
          .filter((m) => m.type === "session_bridge")
          .slice(0, 2);

        if (recent.length === 0) return;

        const lines: string[] = [];
        for (const b of recent) {
          try {
            const data = JSON.parse(b.content) as {
              sessionKey?: string; steps?: number; success?: boolean;
              durationMs?: number; timestamp?: string;
            };
            const duration = Math.round((data.durationMs ?? 0) / 1000);
            const time = data.timestamp
              ? new Date(data.timestamp).toISOString().slice(11, 19)
              : "?";
            const status = data.success ? "ok" : "fail";
            lines.push(`- [${time}] ${status}: ${data.steps ?? 0} steps, ${duration}s`);
          } catch { /* skip malformed */ }
        }

        if (lines.length > 0) {
          context._engramSessionBridge = lines;
          this.logger.info(`L3: injected ${lines.length} session bridges`);
        }
      }, 60);
    }

    // L1: Register propose_memory tool
    ctx.registerTool(this.createProposeMemoryTool());

    // L1: after_run — save proposals, extract, session bridge, dream notification
    ctx.registerHook("after_run", async (context: Record<string, unknown>) => {
      await this.handleAfterRun(context);
    }, 10);

    // L4: Start daily snapshot timer
    if (this.options.dailySnapshot) {
      this.startSnapshotTimer();
    }

    this.logger.info("ActiveMemoryPlugin registered (L0-L4 active)");
  }

  // ══════════════════════════════════════════════════════════════
  // L1: propose_memory tool definition
  // ══════════════════════════════════════════════════════════════

  private createProposeMemoryTool(): ToolDef {
    return {
      name: "propose_memory",
      description: "Save a memory for future recall. Call this when the conversation reveals important information: user corrections, preferences, key facts, customer feedback, competitor intelligence, commitments, or objections. Only extract truly valuable information — do not spam.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["correction", "preference", "fact", "customer_fact", "objection", "commitment", "competitor_intel", "market_signal"],
            description: "Memory type: correction, preference, fact, customer_fact, objection, commitment, competitor_intel, market_signal",
          },
          content: {
            type: "string",
            description: "Memory content — concise and specific",
          },
          customerId: {
            type: "string",
            description: "Optional customer identifier for scoping",
          },
        },
        required: ["type", "content"],
      },
      execute: async (args: Record<string, unknown>) => {
        const { type, content, customerId } = args as {
          type: string; content: string; customerId?: string;
        };
        if (!type || !content) return { ok: false, error: "missing type or content" };
        this.pendingProposals.push({ type, content, customerId });
        this.logger.info(`L1: proposed memory [${type}] ${content.slice(0, 60)}`);
        return { ok: true, message: `Memory proposed (${this.pendingProposals.length} pending)` };
      },
      parallelSafe: true,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // after_run handler — save proposals + extract + session bridge
  // ══════════════════════════════════════════════════════════════

  private async handleAfterRun(context: Record<string, unknown>): Promise<void> {
    const steps = context.steps as number | undefined ?? 0;
    const durationMs = context.durationMs as number | undefined ?? 0;
    const runId = context.runId as string | undefined;
    const sessionKey = context.sessionKey as string | undefined;

    // Save pending proposals
    if (this.pendingProposals.length > 0) {
      const proposals = [...this.pendingProposals];
      this.pendingProposals.length = 0;

      for (const p of proposals) {
        try {
          await this.provider.addMemory({
            type: p.type as MemoryInput["type"],
            scope: "conditional",
            content: p.content,
            context: "L1 agent-proposed",
            tags: [p.type, "agent-proposed"],
            confidence: 0.7,
            source: "agent",
            customerId: p.customerId,
            workspaceId: this.options.workspaceId,
          });
        } catch (err) {
          this.logger.error(`L1: failed to save proposal: ${err}`);
        }
      }
      this.logger.info(`L1: saved ${proposals.length} proposed memories`);
    }

    // L2: Background extraction
    if (this.options.autoExtract && steps >= 2 && durationMs >= 5000) {
      const summaryParts: string[] = [];
      const recent = this.conversationBuffer.slice(-10);
      for (const m of recent) {
        summaryParts.push(`[${m.role === "user" ? "user" : "assistant"}] ${m.content}`);
      }
      this.conversationBuffer.length = 0;

      if (summaryParts.length > 0) {
        const summary = summaryParts.join("\n");
        extractFromSummary(summary, this.provider, {
          llmCall: this.options.llmCall!,
        }).then((count) => {
          if (count > 0) this.logger.info(`L2: extracted ${count} memories`);
        }).catch(() => {});
      }
    }

    // L3: Session bridge
    if (this.options.sessionBridge && sessionKey && steps >= 2) {
      try {
        await this.provider.addMemory({
          type: "session_bridge",
          scope: "ephemeral",
          content: JSON.stringify({
            sessionKey,
            steps,
            durationMs,
            timestamp: new Date().toISOString(),
          }),
          context: "",
          tags: ["session_bridge", "bridge", "auto"],
          confidence: 0.5,
          source: "auto",
          workspaceId: this.options.workspaceId,
        });
      } catch { /* best-effort */ }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // L4: Daily snapshot
  // ══════════════════════════════════════════════════════════════

  private startSnapshotTimer(): void {
    const ONE_HOUR = 3600000;
    this.snapshotTimer = setInterval(async () => {
      const now = new Date();
      const hour = now.getUTCHours() + 8; // UTC+8
      if (hour !== 12) return;

      // Check if snapshot already exists for today
      const store = (this.provider as any).store as MemoryStore | undefined;
      if (!store) return;

      try {
        const stats = await store.getSnapshotStats();
        const todayStr = now.toISOString().slice(0, 10);
        if (stats.latestSnapshot?.includes(todayStr)) return;

        const result = await store.createSnapshot();
        this.logger.info(`L4: daily snapshot completed: ${result.count} memories`);
      } catch (err) {
        this.logger.error(`L4: snapshot failed: ${err}`);
      }
    }, ONE_HOUR);

    // Allow the timer to not keep the process alive
    if (this.snapshotTimer.unref) {
      this.snapshotTimer.unref();
    }
  }

  private stopSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** Clean shutdown */
  async shutdown(): Promise<void> {
    this.stopSnapshotTimer();
    await this.provider.shutdown();
    this.logger.info("ActiveMemoryPlugin shut down");
  }
}
