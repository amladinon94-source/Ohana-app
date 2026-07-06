// Smoke tests for the ohana-comments MCP server.
// Zero dependencies: Node's built-in test runner + child_process over stdio JSON-RPC.
// Run with:  node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "mcp", "ohana-comments-server.js");

// Send a couple of JSON-RPC requests to the server over stdin and collect replies.
function rpc(requests, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, timeout);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", reject);
    p.on("close", () => {
      clearTimeout(timer);
      const msgs = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve(msgs);
    });
    for (const r of requests) p.stdin.write(JSON.stringify(r) + "\n");
    // Give the server a beat to answer, then close stdin so it exits.
    setTimeout(() => p.stdin.end(), 800);
  });
}

test("initialize responds with a protocol version", async () => {
  const msgs = await rpc([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }]);
  const init = msgs.find((m) => m.id === 1);
  assert.ok(init, "no initialize reply");
  assert.ok(init.result && init.result.protocolVersion, "no protocolVersion in result");
});

test("tools/list exposes the Moka + comments + design tools (incl. the new ones)", async () => {
  const msgs = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const list = msgs.find((m) => m.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools), "no tools array");
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.length >= 30, `expected 30+ tools, got ${names.length}`);
  // A few that must exist, including the ones we added this session.
  for (const n of ["ohana_status", "ohana_flow_read", "ohana_flow_add_section", "ohana_flow_add_component", "ohana_flow_set_board", "ohana_flow_connect", "ohana_flow_set_proto"]) {
    assert.ok(names.includes(n), `missing tool: ${n}`);
  }
});

test("every tool declares a name and inputSchema", async () => {
  const msgs = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const tools = msgs.find((m) => m.id === 2).result.tools;
  for (const t of tools) {
    assert.ok(typeof t.name === "string" && t.name, "tool without name");
    assert.equal(t.inputSchema && t.inputSchema.type, "object", `tool ${t.name} has no object inputSchema`);
  }
});
