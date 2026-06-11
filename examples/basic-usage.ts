// Engram — Basic Usage Example
// Run: npx tsx examples/basic-usage.ts

import { ActiveMemoryEngine, JsonlMemoryProvider } from "../src/index";

async function main() {
  console.log("=== Engram Basic Usage ===\n");

  // Option 1: Use the ActiveMemoryEngine (high-level API)
  const engine = new ActiveMemoryEngine({
    storageBasePath: "./engram-example-data",
    dailySnapshot: false,
  });
  await engine.initialize();

  // Propose a memory (L1)
  engine.proposeMemory("fact", "Engram supports JSONL and SQLite storage backends");
  engine.proposeMemory("preference", "Users prefer simple APIs", "user-1");

  // Save proposals
  await engine.afterRun({
    steps: 5,
    durationMs: 10000,
    sessionKey: "example-session-1",
  });

  // Search (L0)
  const result = await engine.beforeStep("storage backends", 0);
  console.log("L0 Retrieved memories:");
  console.log(result.memoryContext || "(none)");
  console.log();

  // Load all
  const provider = engine.getProvider();
  const allMemories = await provider.loadMemories(10);
  console.log(`Total memories: ${allMemories.length}`);
  for (const m of allMemories) {
    console.log(`  [${m.type}] ${m.content}${m.customerId ? ` (${m.customerId})` : ""}`);
  }
  console.log();

  // Stats
  const stats = await provider.getMemoryStats();
  console.log("Stats:", stats);

  await engine.shutdown();

  // Option 2: Use JsonlMemoryProvider directly (low-level API)
  console.log("\n=== Direct Provider Usage ===");
  const provider2 = new JsonlMemoryProvider({ basePath: "./engram-example-data" });
  await provider2.initialize();

  await provider2.addMemory({
    type: "fact",
    content: "Direct provider access works too",
    context: "example",
    tags: ["example"],
    confidence: 0.9,
    source: "demo",
  });

  const mems = await provider2.loadMemories(5);
  console.log(`Provider has ${mems.length} memories`);
  console.log(`Provider name: ${provider2.name}`);
  console.log(`Available: ${await provider2.isAvailable()}`);

  await provider2.shutdown();

  // Cleanup
  const fs = await import("node:fs/promises");
  await fs.rm("./engram-example-data", { recursive: true, force: true });
}

main().catch(console.error);
