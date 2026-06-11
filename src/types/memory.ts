// Engram — Memory Core Types
// Pure data types, zero dependencies, no Electron references.

/** Memory type classification */
export type MemoryType =
  | "fact"
  | "lesson"
  | "preference"
  | "correction"
  | "pattern"
  | "customer_fact"
  | "commitment"
  | "objection"
  | "competitor_intel"
  | "market_signal"
  | "session_bridge"
  | "mistake"
  | "failure_mode"
  | "custom";

/** Memory lifespan scope */
export type MemoryScope = "permanent" | "conditional" | "ephemeral";

/** Memory tier for retrieval prioritization */
export type MemoryTier = "core" | "episodic" | "procedural" | "semantic";

/** A single memory entry */
export interface Memory {
  id: string;
  type: MemoryType;
  tier?: MemoryTier;
  scope?: MemoryScope;
  content: string;
  context: string;
  tags: string[];
  confidence: number;
  source: string;
  sourceSessionKey?: string;
  createdAt: string;
  lastUsed: string;
  accessCount: number;
  usedInResponse?: number;
  customerId?: string;
  importance?: number;
  archived?: boolean;
  embedding?: number[];
  workspaceId?: string;
}

/** Input for creating a new memory (id/timestamps are auto-generated) */
export type MemoryInput = Omit<Memory, "id" | "createdAt" | "lastUsed" | "accessCount">;

/** Partial update patch for a memory entry */
export type MemoryPatch = Partial<Pick<Memory, "content" | "context" | "tags" | "confidence" | "type" | "scope" | "tier" | "importance" | "archived" | "customerId" | "workspaceId">>;

/** Memory provider statistics */
export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  byTier?: Record<string, number>;
  oldestEntry?: string;
  newestEntry?: string;
}

/** Search options */
export interface MemorySearchOptions {
  query: string;
  limit?: number;
  type?: MemoryType;
  customerId?: string;
  workspaceId?: string;
  minConfidence?: number;
}

/** Logger interface (injectable — use console by default) */
export interface EngramLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
