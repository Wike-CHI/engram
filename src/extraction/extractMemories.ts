// Engram — Background Memory Extraction (L2)
// After each agent run, scans conversation summaries and extracts valuable
// memories that the main LLM (L1 propose_memory) may have missed.
// Uses an injectable LLM call function — no framework dependencies.
// Ported from holo-desktop extractMemories.ts.

import type { MemoryProvider } from "../types/pluginTypes";

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

export interface ExtractConfig {
  /** LLM call function: (prompt: string) => Promise<string> */
  llmCall: (prompt: string) => Promise<string>;
  /** Maximum extractions per call (default: 3) */
  maxExtract?: number;
  /** Confidence score for extracted memories (default: 0.6) */
  confidence?: number;
}

export interface ExtractionResult {
  type: string;
  content: string;
}

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

const VALID_TYPES = new Set([
  "fact", "preference", "customer_fact", "commitment",
  "objection", "competitor_intel", "market_signal",
]);

const EXTRACT_PROMPT = `你是一个记忆提取引擎。分析以下对话摘要，提取值得长期记住的信息。

已有记忆（请勿重复）:
{manifest}

对话摘要:
{summary}

提取规则:
- 每条记忆一行，格式: TYPE|内容
- TYPE 只能是: fact, preference, customer_fact, commitment, objection, competitor_intel, market_signal
- 只提取高价值信息：客户偏好、重要承诺、竞品动态、关键决策
- 不要提取: 通用常识、临时性指令、工具操作细节
- 最多提取 {maxExtract} 条
- 如果没有值得提取的信息，输出: NONE`;

// ══════════════════════════════════════════════════════════════
// Parser
// ══════════════════════════════════════════════════════════════

function parseExtractOutput(output: string, maxExtract: number): ExtractionResult[] {
  const results: ExtractionResult[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "NONE" || !trimmed) continue;
    const sep = trimmed.indexOf("|");
    if (sep === -1) continue;
    const type = trimmed.slice(0, sep).trim().toLowerCase();
    const content = trimmed.slice(sep + 1).trim();
    if (!VALID_TYPES.has(type) || !content) continue;
    results.push({ type, content });
    if (results.length >= maxExtract) break;
  }
  return results;
}

// ══════════════════════════════════════════════════════════════
// Main extract function
// ══════════════════════════════════════════════════════════════

/**
 * Extract memories from a conversation summary using an LLM.
 * Returns the number of memories written to the provider.
 */
export async function extractFromSummary(
  summary: string,
  provider: MemoryProvider,
  config: ExtractConfig,
): Promise<number> {
  if (!summary || summary.trim().length < 20) return 0;

  const maxExtract = config.maxExtract ?? 3;
  const confidence = config.confidence ?? 0.6;

  // Build manifest of existing memories to prevent duplicates
  const existingMemories = await provider.loadMemories(200);
  const manifest = existingMemories
    .slice(0, 50)
    .map((m) => `- [${m.type}] ${m.content.slice(0, 60)}`)
    .join("\n");

  const prompt = EXTRACT_PROMPT
    .replace("{manifest}", manifest || "（无）")
    .replace("{summary}", summary.slice(0, 4000))
    .replace("{maxExtract}", String(maxExtract));

  try {
    const output = await config.llmCall(prompt);

    if (!output || output.trim() === "NONE") return 0;

    const extracted = parseExtractOutput(output, maxExtract);
    let written = 0;

    for (const item of extracted) {
      // Dedup: check if similar memory already exists
      const dupes = await provider.searchMemories(item.content.slice(0, 30), 3);
      const isDup = dupes.some(
        (m) => m.type === item.type && m.content.includes(item.content.slice(0, 20)),
      );
      if (isDup) continue;

      await provider.addMemory({
        type: item.type as "fact",
        scope: "conditional",
        content: item.content,
        context: "L2 background auto-extract",
        tags: [item.type, "auto-extract"],
        confidence,
        source: "extract",
      });
      written++;
    }

    return written;
  } catch {
    return 0;
  }
}
