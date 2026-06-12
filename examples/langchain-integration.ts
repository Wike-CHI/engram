// Engram — LangChain Memory Adapter Example
// Run: npx tsx examples/langchain-integration.ts
//
// Shows how to use LangChainMemoryAdapter with various scenarios:
//   - Basic conversation memory
//   - Multi-turn conversation history
//   - Session-scoped memory
//   - Memory clearing

import {
  JsonlMemoryProvider,
  SqliteMemoryProvider,
  LangChainMemoryAdapter,
} from "../src/index";

async function main() {
  console.log("=== Engram LangChain Memory Adapter ===\n");

  await demonstrateBasicUsage();
  await demonstrateMultiTurn();
  await demonstrateSessionScoping();
  await demonstrateClear();

  // Cleanup
  const fs = await import("node:fs/promises");
  await fs.rm("./engram-langchain-example", { recursive: true, force: true });

  console.log("\nDone.");
}

/**
 * Basic usage: single conversation turn with JsonlMemoryProvider.
 */
async function demonstrateBasicUsage() {
  console.log("--- Basic Usage (JsonlMemoryProvider) ---");

  const provider = new JsonlMemoryProvider({
    basePath: "./engram-langchain-example/jsonl",
  });
  await provider.initialize();

  const memory = new LangChainMemoryAdapter(provider, {
    sessionKey: "basic-demo",
  });

  // Save a single conversation turn
  await memory.saveContext(
    { input: "What is the capital of France?" },
    { output: "The capital of France is Paris." },
  );

  // Load memory variables
  const vars = await memory.loadMemoryVariables({});
  console.log("History after 1 turn:");
  console.log(vars.history);
  console.log();

  // Verify it contains the expected content
  console.assert(
    vars.history.includes("Human: What is the capital of France?"),
    "Should contain the human input",
  );
  console.assert(
    vars.history.includes("AI: The capital of France is Paris."),
    "Should contain the AI output",
  );

  await provider.shutdown();
}

/**
 * Multi-turn conversation: demonstrate conversation history accumulation.
 */
async function demonstrateMultiTurn() {
  console.log("--- Multi-Turn Conversation ---");

  const provider = new JsonlMemoryProvider({
    basePath: "./engram-langchain-example/multi-turn",
  });
  await provider.initialize();

  const memory = new LangChainMemoryAdapter(provider, {
    sessionKey: "multi-turn-demo",
  });

  // Simulate a multi-turn conversation
  const conversation = [
    { input: "Hi, I'm Alice.", output: "Hello Alice! Nice to meet you." },
    { input: "What's the weather like?", output: "It's sunny and 72 degrees." },
    { input: "Can you recommend a book?", output: "I recommend 'The Pragmatic Programmer'." },
    { input: "Thanks!", output: "You're welcome! Happy reading." },
  ];

  for (const turn of conversation) {
    await memory.saveContext({ input: turn.input }, { output: turn.output });
  }

  // Load all history
  const vars = await memory.loadMemoryVariables({});
  console.log("Full history:");
  console.log(vars.history);
  console.log();

  // Verify all four turns are present
  const turnCount = vars.history.split("Human:").length - 1;
  console.log(`Conversation turns: ${turnCount}`);
  console.assert(turnCount === 4, `Expected 4 turns, got ${turnCount}`);

  // Test with memoryLimit to restrict history length
  const limitedMemory = new LangChainMemoryAdapter(provider, {
    sessionKey: "multi-turn-demo",
    memoryLimit: 2,
  });

  const limitedVars = await limitedMemory.loadMemoryVariables({});
  const limitedTurnCount = limitedVars.history.split("Human:").length - 1;
  console.log(`Limited history turns (limit=2): ${limitedTurnCount}`);
  console.assert(
    limitedTurnCount === 2,
    `Expected 2 turns with limit, got ${limitedTurnCount}`,
  );

  await provider.shutdown();
}

/**
 * Session scoping: two isolated sessions share the same provider.
 */
async function demonstrateSessionScoping() {
  console.log("--- Session Scoping ---");

  const provider = new JsonlMemoryProvider({
    basePath: "./engram-langchain-example/sessions",
  });
  await provider.initialize();

  const sessionA = new LangChainMemoryAdapter(provider, {
    sessionKey: "session-a",
  });
  const sessionB = new LangChainMemoryAdapter(provider, {
    sessionKey: "session-b",
  });

  // Session A: discuss cats
  await sessionA.saveContext(
    { input: "Do you like cats?" },
    { output: "I love cats! They're great companions." },
  );

  // Session B: discuss dogs
  await sessionB.saveContext(
    { input: "Tell me about dogs." },
    { output: "Dogs are loyal and friendly animals." },
  );

  // Each session should only see its own history
  const varsA = await sessionA.loadMemoryVariables({});
  console.log("Session A history:");
  console.log(varsA.history);
  console.assert(
    varsA.history.includes("cats") && !varsA.history.includes("dogs"),
    "Session A should only see cat conversation",
  );

  const varsB = await sessionB.loadMemoryVariables({});
  console.log("Session B history:");
  console.log(varsB.history);
  console.assert(
    varsB.history.includes("dogs") && !varsB.history.includes("cats"),
    "Session B should only see dog conversation",
  );

  await provider.shutdown();
}

/**
 * Memory clearing: demonstrate clear() scoped to the adapter's session.
 */
async function demonstrateClear() {
  console.log("--- Memory Clearing ---");

  const provider = new JsonlMemoryProvider({
    basePath: "./engram-langchain-example/clear",
  });
  await provider.initialize();

  const memory = new LangChainMemoryAdapter(provider, {
    sessionKey: "clear-demo",
  });

  // Save some data
  await memory.saveContext(
    { input: "Hello", output: "Hi there!" },
  );

  // Also add a non-adapter memory to prove it survives clear
  await provider.addMemory({
    type: "fact",
    content: "This should persist after clear",
    context: "test",
    tags: ["persistent"],
    confidence: 0.9,
    source: "manual",
  });

  // Clear only adapter memories
  await memory.clear();

  // Load provider memories — only the non-adapter one should remain
  const allMemories = await provider.loadMemories(0);
  console.log(`Memories after clear: ${allMemories.length}`);
  console.assert(
    allMemories.length === 1,
    `Expected 1 memory (non-adapter), got ${allMemories.length}`,
  );
  console.assert(
    allMemories[0].content === "This should persist after clear",
    "Non-adapter memory should survive clear",
  );

  // Verify adapter history is empty
  const vars = await memory.loadMemoryVariables({});
  console.log(`Adapter history after clear: "${vars.history}"`);
  console.assert(vars.history === "", "History should be empty after clear");

  await provider.shutdown();
}

main().catch(console.error);
