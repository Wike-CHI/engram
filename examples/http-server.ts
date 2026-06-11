// Engram — Standalone HTTP Server Example
// Run: npx tsx examples/http-server.ts
// Then: curl http://localhost:3456/health

import { StandaloneServer } from "../src/index";

async function main() {
  const server = new StandaloneServer({
    port: 3456,
    host: "localhost",
    // apiKey: "my-secret-key", // Uncomment for auth
  });

  await server.start();
  console.log("\nEngram API ready at http://localhost:3456\n");
  console.log("Endpoints:");
  console.log("  GET  /health             — Health check");
  console.log("  GET  /memories?limit=20  — List memories");
  console.log("  POST /memories           — Add a memory");
  console.log("  GET  /memories/search?q= — Search memories");
  console.log("  GET  /memories/context?topic= — Build context");
  console.log("  DELETE /memories/:id     — Delete a memory");
  console.log("  GET  /stats              — Memory statistics");
  console.log("  POST /memories/propose   — Propose a memory");
  console.log("\nTest it:");
  console.log("  curl http://localhost:3456/health");
  console.log("  curl -X POST http://localhost:3456/memories \\");
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"type":"fact","content":"hello engram","tags":["test"],"confidence":0.9,"source":"curl"}\'');
  console.log('  curl "http://localhost:3456/memories/search?q=hello"');
  console.log("\nPress Ctrl+C to stop");
}

main().catch(console.error);
