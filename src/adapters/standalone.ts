// Engram — Standalone HTTP Server Adapter
// Runs Engram as a standalone HTTP service.
// No framework dependencies — uses Node.js built-in http module.
//
// ## Usage
// ```typescript
// import { StandaloneServer } from "engram";
//
// const server = new StandaloneServer({
//   storageBasePath: "./engram-data",
//   port: 3456,
// });
// await server.start();
// console.log("Engram API at http://localhost:3456");
// ```

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { ActiveMemoryEngine } from "../core/activeMemoryEngine";
import type { StandaloneServerConfig } from "./types";

/**
 * StandaloneServer — lightweight HTTP server exposing Engram's API.
 * Designed for sidecar deployments or remote memory access.
 */
export class StandaloneServer {
  private engine: ActiveMemoryEngine;
  private server: http.Server | null = null;
  private config: Required<StandaloneServerConfig>;

  constructor(config: StandaloneServerConfig = {}) {
    this.config = {
      port: config.port ?? 3456,
      host: config.host ?? "localhost",
      apiKey: config.apiKey ?? "",
    };

    this.engine = new ActiveMemoryEngine({
      storageBasePath: "./engram-data",
      dailySnapshot: true,
    });
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    await this.engine.initialize();

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[engram:server] listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP server */
  async stop(): Promise<void> {
    await this.engine.shutdown();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get the underlying engine */
  getEngine(): ActiveMemoryEngine {
    return this.engine;
  }

  // ══════════════════════════════════════════════════════════════
  // Request handler
  // ══════════════════════════════════════════════════════════════

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (this.config.apiKey) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== this.config.apiKey) {
        this.json(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      const body = await this.readBody(req);
      const provider = this.engine.getProvider();

      switch (true) {
        // GET /health — health check
        case req.method === "GET" && path === "/health":
          this.json(res, 200, {
            status: "ok",
            name: provider.name,
          });
          break;

        // GET /memories — list memories
        case req.method === "GET" && path === "/memories":
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const memories = await provider.loadMemories(limit);
          this.json(res, 200, { memories, total: memories.length });
          break;

        // POST /memories — add a memory
        case req.method === "POST" && path === "/memories":
          const input = typeof body === "object" ? body : JSON.parse(body as string);
          const added = await provider.addMemory(input);
          this.json(res, 201, { memory: added });
          break;

        // GET /memories/search?q=... — search memories
        case req.method === "GET" && path === "/memories/search":
          const query = url.searchParams.get("q") ?? "";
          const searchLimit = parseInt(url.searchParams.get("limit") ?? "10", 10);
          const results = await provider.searchMemories(query, searchLimit);
          this.json(res, 200, { results, total: results.length });
          break;

        // GET /memories/context?topic=... — build memory context
        case req.method === "GET" && path === "/memories/context":
          const topic = url.searchParams.get("topic") ?? undefined;
          const ctx = await provider.buildMemoryContext(topic);
          this.json(res, 200, { context: ctx });
          break;

        // DELETE /memories/:id — delete a memory
        case req.method === "DELETE" && path.startsWith("/memories/"):
          const id = path.slice("/memories/".length);
          const deleted = await provider.deleteMemory(id);
          this.json(res, deleted ? 200 : 404, { deleted });
          break;

        // GET /stats — memory statistics
        case req.method === "GET" && path === "/stats":
          const stats = await provider.getMemoryStats();
          this.json(res, 200, stats);
          break;

        // POST /before_step — run before_step hook
        case req.method === "POST" && path === "/hooks/before_step":
          const bBody = (typeof body === "object" ? body : JSON.parse(body as string)) as { userMessage?: string; step?: number };
          const bResult = await this.engine.beforeStep(bBody?.userMessage ?? "", bBody?.step ?? 0);
          this.json(res, 200, bResult);
          break;

        // POST /after_run — run after_run hook
        case req.method === "POST" && path === "/hooks/after_run":
          const aBody = (typeof body === "object" ? body : JSON.parse(body as string));
          await this.engine.afterRun({
            steps: aBody?.steps ?? 0,
            durationMs: aBody?.durationMs ?? 0,
            sessionKey: aBody?.sessionKey ?? undefined,
            runId: aBody?.runId ?? undefined,
          });
          this.json(res, 200, { ok: true });
          break;

        // Propose a memory
        case req.method === "POST" && path === "/memories/propose":
          const pBody = (typeof body === "object" ? body : JSON.parse(body as string));
          const result = this.engine.proposeMemory(
            pBody?.type ?? "fact",
            pBody?.content ?? "",
            pBody?.customerId ?? undefined,
          );
          this.json(res, 200, result);
          // Auto-save the proposal
          await this.engine.afterRun({ steps: 1, durationMs: 100 });
          break;

        default:
          this.json(res, 404, { error: "Not Found" });
      }
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : "Internal Server Error" });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string | Record<string, unknown>> {
    return new Promise((resolve) => {
      if (req.method === "GET" || req.method === "DELETE") {
        resolve("");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) resolve("");
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
      req.on("error", () => resolve(""));
    });
  }
}
