// Engram — ActiveMemoryEngine
// Direct orchestration layer for using Active Memory without PluginContext.
// Provides a simplified API for before_step / after_run lifecycle management.
// Useful for standalone use or integration with frameworks that don't support
// the Plugin interface yet.

import type { MemoryProvider } from "../types/pluginTypes";
import type { Memory, MemoryInput, EngramLogger } from "../types/memory";
import {
  ActiveMemoryPlugin,
  type ActiveMemoryPluginOptions,
} from "../plugin/activeMemoryPlugin";
import { JsonlMemoryProvider } from "../providers/jsonlProvider";
import { MemoryStore } from "../stores/memoryStore";
import type { EmbeddingFn } from "../stores/memoryStore";

/** Simplified ActiveMemoryEngine options */
export interface ActiveMemoryEngineOptions {
  /** Base path for memory storage */
  storageBasePath?: string;
  /** Optional embedding function */
  embeddingFn?: EmbeddingFn | null;
  /** Workspace ID for isolation */
  workspaceId?: string;
  /** Maximum memories to inject (default: 5) */
  activeMemoryLimit?: number;
  /** LLM call function for background extraction */
  llmCall?: (prompt: string) => Promise<string>;
  /** Enable daily snapshots (default: true) */
  dailySnapshot?: boolean;
  /** Custom logger */
  logger?: EngramLogger;
}

/**
 * BeforeStep result — what to inject into the agent's context
 */
export interface BeforeStepResult {
  /** Memories relevant to the current user message */
  memories: Memory[];
  /** Formatted memory lines ready for system prompt injection */
  memoryContext: string;
  /** Session bridges for cross-session continuity */
  sessionBridges: string[];
}

/**
 * AfterRun input — information about the completed run
 */
export interface RunCompletion {
  runId?: string;
  sessionKey?: string;
  steps: number;
  durationMs: number;
  userMessages?: Array<{ role: string; content: string }>;
}

/**
 * ActiveMemoryEngine — direct access to Active Memory layers.
 * Use this when you want to call before_step / after_run manually,
 * without registering as a Plugin.
 */
export class ActiveMemoryEngine {
  private provider: MemoryProvider;
  private options: Required<ActiveMemoryEngineOptions>;
  private logger: EngramLogger;
  private plugin: ActiveMemoryPlugin;
  private conversationBuffer: Array<{ role: string; content: string }> = [];
  private pendingProposals: Array<{ type: string; content: string; customerId?: string }> = [];

  constructor(options: ActiveMemoryEngineOptions = {}) {
    this.options = {
      storageBasePath: options.storageBasePath ?? "./engram-data",
      embeddingFn: options.embeddingFn ?? null,
      workspaceId: options.workspaceId ?? "default",
      activeMemoryLimit: options.activeMemoryLimit ?? 5,
      llmCall: options.llmCall ?? (async () => "NONE"),
      dailySnapshot: options.dailySnapshot ?? true,
      logger: options.logger ?? {
        info: (msg) => console.log(`[engram:engine] ${msg}`),
        warn: (msg) => console.warn(`[engram:engine] ${msg}`),
        error: (msg) => console.error(`[engram:engine] ${msg}`),
        debug: () => {},
      },
    };
    this.logger = this.options.logger;

    this.provider = new JsonlMemoryProvider({
      basePath: this.options.storageBasePath,
      embeddingFn: this.options.embeddingFn,
    });

    // Create the plugin internally for reuse
    this.plugin = new ActiveMemoryPlugin({
      memoryProvider: this.provider,
      storageBasePath: this.options.storageBasePath,
      workspaceId: this.options.workspaceId,
      activeMemoryLimit: this.options.activeMemoryLimit,
      llmCall: this.options.llmCall,
      autoExtract: true,
      sessionBridge: true,
      dailySnapshot: this.options.dailySnapshot,
      logger: this.options.logger,
    });
  }

  /** Initialize the engine and underlying provider */
  async initialize(): Promise<void> {
    await this.provider.initialize();
  }

  /** Shutdown the engine */
  async shutdown(): Promise<void> {
    await this.plugin.shutdown();
  }

  /** Get the underlying MemoryProvider */
  getProvider(): MemoryProvider {
    return this.provider;
  }

  // ══════════════════════════════════════════════════════════════
  // L0: Before Step — retrieve and format relevant memories
  // ══════════════════════════════════════════════════════════════

  /**
   * Process before an agent step: search for relevant memories and session bridges.
   * Returns formatted context ready for system prompt injection.
   */
  async beforeStep(userMessage: string, stepIndex = 0): Promise<BeforeStepResult> {
    // Track conversation for extraction
    if (stepIndex === 0) {
      this.conversationBuffer.push({ role: "user", content: userMessage.slice(0, 500) });
      if (this.conversationBuffer.length > 20) {
        this.conversationBuffer.splice(0, this.conversationBuffer.length - 20);
      }
    }

    // Search memories
    const allMemories = await this.provider.searchMemories(
      userMessage,
      this.options.activeMemoryLimit,
    );
    const memories = allMemories.filter(
      (m) => (m.workspaceId ?? "default") === this.options.workspaceId,
    );

    const lines = memories.map((m) => {
      const tag = m.customerId ? `[${m.customerId}] ` : "";
      return `- [${m.type}] ${tag}${m.content}`;
    });

    const memoryContext = lines.length > 0
      ? `[Engram — 相关记忆]\n${lines.join("\n")}`
      : "";

    // Session bridges (only on step 0)
    let sessionBridges: string[] = [];
    if (stepIndex === 0) {
      const bridges = await this.provider.searchMemories("session_bridge", 3);
      sessionBridges = bridges
        .filter((m) => m.type === "session_bridge")
        .slice(0, 2)
        .map((b) => {
          try {
            const d = JSON.parse(b.content);
            return `[${d.timestamp?.slice(11, 19) ?? "?"}] ${d.success ? "ok" : "fail"}: ${d.steps ?? 0} steps`;
          } catch {
            return "";
          }
        })
        .filter(Boolean);
    }

    return { memories, memoryContext, sessionBridges };
  }

  // ══════════════════════════════════════════════════════════════
  // L1: Propose a memory (call from agent tool)
  // ══════════════════════════════════════════════════════════════

  /**
   * Propose a memory for storage (called by the agent via propose_memory tool)
   */
  proposeMemory(type: string, content: string, customerId?: string): { ok: boolean; message: string } {
    this.pendingProposals.push({ type, content, customerId });
    return { ok: true, message: `Memory proposed (${this.pendingProposals.length} pending)` };
  }

  /** Get the propose_memory tool definition for agent registration */
  getProposeMemoryTool() {
    return this.plugin["createProposeMemoryTool"]();
  }

  // ══════════════════════════════════════════════════════════════
  // L1/L2/L3: After Run — save proposals, extract, session bridge
  // ══════════════════════════════════════════════════════════════

  /**
   * Process after an agent run completes.
   * - Saves proposed memories
   * - Extracts new memories from conversation (L2)
   * - Creates session bridge (L3)
   */
  async afterRun(completion: RunCompletion): Promise<void> {
    const { steps, durationMs, sessionKey } = completion;

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
    if (this.options.llmCall && steps >= 2 && durationMs >= 5000) {
      const summaryParts: string[] = [];
      const recent = this.conversationBuffer.slice(-10);
      for (const m of recent) {
        summaryParts.push(`[${m.role}] ${m.content}`);
      }
      this.conversationBuffer.length = 0;

      if (summaryParts.length > 0) {
        const { extractFromSummary } = await import("../extraction/extractMemories");
        extractFromSummary(summaryParts.join("\n"), this.provider, {
          llmCall: this.options.llmCall,
        }).then((count) => {
          if (count > 0) this.logger.info(`L2: extracted ${count} memories`);
        }).catch(() => {});
      }
    }

    // L3: Session bridge
    if (sessionKey && steps >= 2) {
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
}
