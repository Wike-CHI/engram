// Engram — LangChain Framework Adapter
// Wraps Engram's MemoryProvider as a LangChain-compatible memory.
// LangChain is NOT a dependency — defines its own minimal BaseMemory interface.

import type { MemoryProvider } from "../types/pluginTypes";

// ══════════════════════════════════════════════════════════════
// Minimal LangChain-compatible interfaces
// ══════════════════════════════════════════════════════════════

/**
 * The result of loading memory variables.
 * LangChain expects at least a `history` key with the formatted conversation text.
 */
export interface MemoryVariables {
  /** Formatted conversation history string */
  history: string;
  /** Additional memory variables (framework-specific) */
  [key: string]: unknown;
}

/**
 * Minimal BaseMemory interface following LangChain's pattern.
 *
 * LangChain's BaseMemory defines:
 * - `loadMemoryVariables(inputValues)`: load context from memory
 * - `saveContext(inputValues, outputValues)`: save a conversation turn
 * - `clear()`: reset memory state
 */
export interface BaseMemory {
  /** Load memory variables from the underlying store */
  loadMemoryVariables(inputValues: Record<string, unknown>): Promise<MemoryVariables>;

  /** Save a conversation turn (input + output) to memory */
  saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown>,
  ): Promise<void>;

  /** Clear all managed memory entries */
  clear(): Promise<void>;
}

// ══════════════════════════════════════════════════════════════
// LangChainMemoryAdapter configuration
// ══════════════════════════════════════════════════════════════

export interface LangChainMemoryAdapterConfig {
  /** Session key for scoping memories (default: "default") */
  sessionKey?: string;

  /** Prefix for human messages in formatted history (default: "Human") */
  humanPrefix?: string;

  /** Prefix for AI messages in formatted history (default: "AI") */
  aiPrefix?: string;

  /** Maximum number of recent conversation turns to include (default: 20) */
  memoryLimit?: number;

  /**
   * Rough hint for maximum characters in returned history string.
   * If set, the adapter truncates the oldest turns first.
   * 0 or undefined means no limit.
   */
  maxTokensHint?: number;

  /** Tag to use for marking adapter-created memories (default: "langchain_memory") */
  tag?: string;
}

// ══════════════════════════════════════════════════════════════
// LangChainMemoryAdapter
// ══════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: Required<LangChainMemoryAdapterConfig> = {
  sessionKey: "default",
  humanPrefix: "Human",
  aiPrefix: "AI",
  memoryLimit: 20,
  maxTokensHint: 0,
  tag: "langchain_memory",
};

/**
 * LangChainMemoryAdapter — wraps Engram's MemoryProvider as a LangChain-compatible memory.
 *
 * Each conversation turn is stored as a single "fact" memory entry tagged with
 * the adapter's tag (default: "langchain_memory") for easy scoping and cleanup.
 *
 * ## Usage
 * ```typescript
 * import { JsonlMemoryProvider, LangChainMemoryAdapter } from "engram";
 *
 * const provider = new JsonlMemoryProvider({ basePath: "./data" });
 * await provider.initialize();
 *
 * const memory = new LangChainMemoryAdapter(provider, {
 *   sessionKey: "session-1",
 * });
 *
 * // Save a conversation turn
 * await memory.saveContext(
 *   { input: "Hello" },
 *   { output: "Hi! How can I help?" }
 * );
 *
 * // Load conversation history
 * const vars = await memory.loadMemoryVariables({});
 * console.log(vars.history);
 * // Human: Hello
 * // AI: Hi! How can I help?
 * ```
 */
export class LangChainMemoryAdapter implements BaseMemory {
  private provider: MemoryProvider;
  private config: Required<LangChainMemoryAdapterConfig>;

  constructor(
    provider: MemoryProvider,
    config: LangChainMemoryAdapterConfig = {},
  ) {
    this.provider = provider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load conversation history from Engram memory.
   *
   * Retrieves recent memories tagged with the adapter's tag, formats them
   * as a conversation history string, and returns them in the `history` key.
   *
   * @param inputValues - Optional input values (used for context-aware retrieval)
   * @returns MemoryVariables with `history` containing formatted conversation text
   */
  async loadMemoryVariables(
    inputValues: Record<string, unknown> = {},
  ): Promise<MemoryVariables> {
    const { tag, memoryLimit, maxTokensHint } = this.config;

    // Load recent memories (newest first)
    const memories = await this.provider.loadMemories(memoryLimit);

    // Filter to only our tagged memories for this session
    const relevant = memories.filter(
      (m) => m.tags.includes(tag) && m.source === this.config.sessionKey,
    );

    // Build history string (already newest-first from loadMemories)
    let history = relevant.map((m) => m.content).join("\n");

    // Optionally truncate by rough char limit
    if (maxTokensHint > 0 && history.length > maxTokensHint) {
      const lines = history.split("\n");
      const truncated: string[] = [];
      let charCount = 0;

      // Keep newest lines (appear first due to reverse-chronological order)
      for (const line of lines) {
        const lineLen = line.length + 1; // +1 for newline separator
        if (charCount + lineLen > maxTokensHint) break;
        truncated.push(line);
        charCount += lineLen;
      }

      history = truncated.join("\n");
    }

    return { history };
  }

  /**
   * Save a conversation turn to Engram memory.
   *
   * Stores the input/output pair as a single "fact" memory entry with
   * the adapter's tag and the configured session key as source.
   *
   * @param inputValues - The human input (expects `input` key)
   * @param outputValues - The AI output (expects `output` key)
   */
  async saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown>,
  ): Promise<void> {
    const input = this.extractString(inputValues, "input");
    const output = this.extractString(outputValues, "output");

    // Format the conversation turn
    const content = `${this.config.humanPrefix}: ${input}\n${this.config.aiPrefix}: ${output}`;

    await this.provider.addMemory({
      type: "fact",
      content,
      context: `Conversation turn (${this.config.sessionKey})`,
      tags: [this.config.tag, `session:${this.config.sessionKey}`],
      confidence: 1.0,
      source: this.config.sessionKey,
    });
  }

  /**
   * Clear all memories managed by this adapter.
   *
   * Only deletes memories tagged with the adapter's tag — other
   * engram memories (e.g., from other adapters or direct use)
   * are left untouched.
   */
  async clear(): Promise<void> {
    const { tag } = this.config;

    // Load all memories to find our tagged ones
    const allMemories = await this.provider.loadMemories(0);
    const tagged = allMemories.filter(
      (m) => m.tags.includes(tag) && m.source === this.config.sessionKey,
    );

    // Delete them one by one
    for (const mem of tagged) {
      await this.provider.deleteMemory(mem.id);
    }
  }

  /**
   * Extract a string value from a record, trying multiple key names.
   * LangChain chains commonly use different key names for the same concept.
   */
  private extractString(
    record: Record<string, unknown>,
    kind: "input" | "output",
  ): string {
    const candidates =
      kind === "input"
        ? ["input", "human_input", "question", "message", "text"]
        : ["output", "ai_output", "response", "answer", "text"];

    for (const key of candidates) {
      const val = record[key];
      if (typeof val === "string") return val;
      if (typeof val === "object" && val !== null) {
        // Try to stringify complex objects
        const stringified = JSON.stringify(val);
        if (stringified && stringified !== "{}") return stringified;
      }
    }

    return `[${kind} not provided]`;
  }
}
