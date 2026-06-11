// Engram — SqliteMemoryProvider
// SQLite + FTS5 backed memory provider. Zero external services.
// Uses better-sqlite3 as an optional peer dependency — install it separately.
//
// ## Usage
// ```typescript
// import Database from "better-sqlite3";
// import { SqliteMemoryProvider } from "engram/providers/sqlite";
//
// const provider = new SqliteMemoryProvider({
//   dbPath: "./engram-memory.db",
//   Database,  // <-- pass the constructor from better-sqlite3
// });
// ```

import type { Memory, MemoryInput, MemoryPatch, MemoryStats } from "../types/memory";
import type { MemoryProvider } from "../types/pluginTypes";

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

/** Subset of better-sqlite3's Database interface */
export interface SqliteDatabase {
  exec(sql: string): this;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): unknown;
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
  close(): void;
  backup(destPath: string): void;
}

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabaseConstructor {
  new (path: string, options?: Record<string, unknown>): SqliteDatabase;
}

/** Options for SqliteMemoryProvider */
export interface SqliteProviderOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** The better-sqlite3 Database constructor (injected to avoid hard dependency) */
  Database: SqliteDatabaseConstructor;
  /** Optional logger */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ══════════════════════════════════════════════════════════════
// SqliteMemoryProvider
// ══════════════════════════════════════════════════════════════

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";
  private db!: SqliteDatabase;
  private options: SqliteProviderOptions;
  private initialized = false;

  constructor(options: SqliteProviderOptions) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async initialize(): Promise<void> {
    const { dbPath, Database } = this.options;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      this.db.close();
      this.initialized = false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Schema
  // ══════════════════════════════════════════════════════════════

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT DEFAULT '',
        tags_json TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0.5,
        source TEXT DEFAULT '',
        source_session_key TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        last_used TEXT NOT NULL,
        access_count INTEGER DEFAULT 0,
        used_in_response INTEGER DEFAULT 0,
        customer_id TEXT,
        importance REAL DEFAULT 0.0,
        archived INTEGER DEFAULT 0,
        workspace_id TEXT DEFAULT 'default'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        type, content, context, tags_json,
        content=memories, content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, type, content, context, tags_json)
        VALUES (new.rowid, new.type, new.content, new.context, new.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, type, content, context, tags_json)
        VALUES ('delete', old.rowid, old.type, old.content, old.context, old.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, type, content, context, tags_json)
        VALUES ('delete', old.rowid, old.type, old.content, old.context, old.tags_json);
        INSERT INTO memories_fts(rowid, type, content, context, tags_json)
        VALUES (new.rowid, new.type, new.content, new.context, new.tags_json);
      END;

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_customer ON memories(customer_id);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
    `);
  }

  // ══════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════

  async addMemory(input: MemoryInput): Promise<Memory> {
    const now = new Date().toISOString();
    const memory: Memory = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      lastUsed: now,
      accessCount: 0,
    };

    this.db.prepare(`
      INSERT INTO memories (id, type, content, context, tags_json, confidence, source, source_session_key,
                            created_at, last_used, access_count, customer_id, importance, archived, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id, memory.type, memory.content, memory.context,
      JSON.stringify(memory.tags), memory.confidence, memory.source, memory.sourceSessionKey ?? "",
      memory.createdAt, memory.lastUsed, memory.accessCount,
      memory.customerId ?? null, 0.0, 0, memory.workspaceId ?? "default",
    );

    return memory;
  }

  async loadMemories(limit = 50): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE archived = 0 ORDER BY last_used DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r));
  }

  async searchMemories(query: string, limit = 10): Promise<Memory[]> {
    if (!query.trim()) return [];

    // Try FTS5 BM25 search first
    try {
      const ftsQuery = this.buildFtsQuery(query);
      const rows = this.db.prepare(`
        SELECT memories.*, rank FROM memories_fts
        JOIN memories ON memories.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND memories.archived = 0
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, Math.max(limit * 3, 30)) as Array<Record<string, unknown>>;

      if (rows.length > 0) {
        return rows.slice(0, limit).map((r) => this.rowToMemory(r));
      }
    } catch {
      // fall through to LIKE fallback
    }

    // LIKE fallback for simple/substring queries
    const like = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE archived = 0
        AND (content LIKE ? OR context LIKE ?)
      ORDER BY importance DESC, last_used DESC LIMIT ?
    `).all(like, like, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r));
  }

  async getRelevantMemories(tags: string[], limit = 10): Promise<Memory[]> {
    if (tags.length === 0) return [];

    const tagQuery = tags.map((t) => `"${t}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT memories.* FROM memories_fts
        JOIN memories ON memories.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND memories.archived = 0
        ORDER BY importance DESC LIMIT ?
      `).all(tagQuery, limit * 2) as Array<Record<string, unknown>>;
      return rows.slice(0, limit).map((r) => this.rowToMemory(r));
    } catch {
      // LIKE fallback
      const rows = this.db.prepare(`
        SELECT * FROM memories WHERE archived = 0
          AND tags_json LIKE ?
        ORDER BY importance DESC LIMIT ?
      `).all(`%${tags[0]}%`, limit) as Array<Record<string, unknown>>;
      return rows.slice(0, limit).map((r) => this.rowToMemory(r));
    }
  }

  async buildMemoryContext(currentTopic?: string): Promise<string> {
    let rows: Array<Record<string, unknown>>;

    if (currentTopic) {
      try {
        const ftsQuery = this.buildFtsQuery(currentTopic);
        rows = this.db.prepare(`
          SELECT memories.* FROM memories_fts
          JOIN memories ON memories.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND memories.archived = 0
          ORDER BY importance DESC LIMIT 12
        `).all(ftsQuery) as Array<Record<string, unknown>>;
      } catch {
        rows = this.db.prepare(`
          SELECT * FROM memories WHERE archived = 0 ORDER BY importance DESC LIMIT 10
        `).all() as Array<Record<string, unknown>>;
      }
    } else {
      rows = this.db.prepare(`
        SELECT * FROM memories WHERE archived = 0
        ORDER BY importance DESC, last_used DESC LIMIT 12
      `).all() as Array<Record<string, unknown>>;
    }

    if (rows.length === 0) return "";
    const memories = rows.map((r) => this.rowToMemory(r));

    const lines = memories.map((m) => {
      const tag = m.customerId ? `[${m.customerId}] ` : "";
      const star = (m.importance ?? 0) > 0.7 ? " ★" : "";
      return `- [${m.type}] ${tag}${m.content}${star}`;
    });

    return `[Engram Memory — 相关记忆]\n${lines.join("\n")}`;
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0").get() as { c: number }).c;
    const byTypeRows = this.db.prepare("SELECT type, COUNT(*) as c FROM memories WHERE archived = 0 GROUP BY type").all() as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.type] = r.c;
    return { total, byType };
  }

  async deleteMemory(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async updateMemory(id: string, patch: MemoryPatch): Promise<Memory | null> {
    const existing = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!existing) return null;

    const merged: Record<string, unknown> = { ...existing, ...patch };
    if (patch.tags) merged.tags_json = JSON.stringify(patch.tags);

    this.db.prepare(`
      UPDATE memories SET type=?, content=?, context=?, tags_json=?, confidence=?,
        source=?, customer_id=?, importance=?, archived=?, workspace_id=?
      WHERE id=?
    `).run(
      merged.type, merged.content, merged.context, merged.tags_json,
      merged.confidence, merged.source,
      merged.customer_id ?? null, merged.importance ?? 0,
      merged.archived ? 1 : 0, merged.workspace_id ?? "default",
      id,
    );

    return this.rowToMemory(merged);
  }

  async touchMemory(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories SET last_used = ?, access_count = access_count + 1 WHERE id = ?
    `).run(now, id);
  }

  // ══════════════════════════════════════════════════════════════
  // Snapshots
  // ══════════════════════════════════════════════════════════════

  /** Checkpoint and create a snapshot backup of the SQLite database */
  createSnapshot(snapshotPath: string): { path: string; count: number } {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.backup(snapshotPath);
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0").get() as { c: number }).c;
    return { path: snapshotPath, count };
  }

  // ══════════════════════════════════════════════════════════════
  // Export / Import
  // ══════════════════════════════════════════════════════════════

  /** Export all memories (for migration to another provider) */
  exportMemories(): Memory[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE archived = 0 ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r));
  }

  /** Import memories from another provider (dedup by id) */
  importMemories(memories: Memory[]): number {
    let imported = 0;
    for (const m of memories) {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(m.id);
      if (existing) continue;

      this.db.prepare(`
        INSERT OR IGNORE INTO memories (id, type, content, context, tags_json, confidence, source, source_session_key,
                                        created_at, last_used, access_count, used_in_response, customer_id, importance, archived, workspace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        m.id, m.type, m.content, m.context, JSON.stringify(m.tags),
        m.confidence, m.source, m.sourceSessionKey ?? "",
        m.createdAt, m.lastUsed, m.accessCount, m.usedInResponse ?? 0,
        m.customerId ?? null, m.importance ?? 0, m.archived ? 1 : 0,
        m.workspaceId ?? "default",
      );
      imported++;
    }
    return imported;
  }

  // ══════════════════════════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════════════════════════

  private buildFtsQuery(query: string): string {
    const terms = query
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return '""';
    return terms.map((t) => `"${t}"`).join(" OR ") + "*";
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      type: row.type as Memory["type"],
      content: row.content as string,
      context: (row.context as string) ?? "",
      tags: this.parseTags(row.tags_json as string),
      confidence: (row.confidence as number) ?? 0.5,
      source: (row.source as string) ?? "",
      sourceSessionKey: (row.source_session_key as string) || undefined,
      createdAt: row.created_at as string,
      lastUsed: row.last_used as string,
      accessCount: (row.access_count as number) ?? 0,
      usedInResponse: (row.used_in_response as number) ?? 0,
      customerId: (row.customer_id as string) ?? undefined,
      importance: (row.importance as number) ?? 0,
      archived: (row.archived as number) === 1,
      workspaceId: (row.workspace_id as string) ?? undefined,
    };
  }

  private parseTags(json: string): string[] {
    try { return JSON.parse(json); }
    catch { return []; }
  }
}
