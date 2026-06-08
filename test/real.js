// Real end-to-end test: drives the extension's agent loop against a LIVE llama-server
// running the actual Qwen3-Coder model. Measures speed and verifies a real task.
// Usage: node test/real.js   (needs llama-server up on :8080 with --jinja)
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-real-"));
const CONFIG = {
  endpoint: process.env.QWEN_ENDPOINT || "http://localhost:8080/v1",
  model: "qwen3-coder", temperature: 0.2, maxIterations: 25,
  autoApprove: true, apiKey: "", commandTimeoutSec: 120, // autoApprove: no UI in this test
};
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k) => CONFIG[k] }), workspaceFolders: [{ uri: { fsPath: WS } }], openTextDocument: async () => ({}) },
  window: { showTextDocument: async () => ({}), showWarningMessage: async () => "Approve", registerWebviewViewProvider: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};
const origLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };
const T = require("../extension.js")._test;

(async () => {
  T.loadSkills(path.join(__dirname, ".."));
  console.log("workspace:", WS, "\nendpoint:", CONFIG.endpoint, "\n");

  // --- raw speed probe ---
  console.log("[speed] one completion…");
  const t0 = Date.now();
  const res = await fetch(CONFIG.endpoint + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CONFIG.model, messages: [{ role: "user", content: "Write a 2-line poem about servers." }], temperature: 0.2, stream: false }),
  });
  const data = await res.json();
  const dt = (Date.now() - t0) / 1000;
  const toks = data.usage ? data.usage.completion_tokens : (data.choices[0].message.content || "").split(/\s+/).length;
  console.log(`  ${toks} tokens in ${dt.toFixed(1)}s  →  ~${(toks / dt).toFixed(1)} tok/s`);
  console.log("  sample:", JSON.stringify((data.choices[0].message.content || "").slice(0, 80)));

  // --- real agentic task ---
  console.log("\n[agent] task: create fib.py and run it…");
  const events = [];
  const ta = Date.now();
  await T.runAgent(
    "Create a file fib.py with a function fib(n) returning the nth Fibonacci number (iterative). Then run it with python3 so it prints fib(10). Verify the output is 55.",
    [{ role: "system", content: require("fs").existsSync ? "" : "" }, { role: "system", content: "You are Qwen Coder. Use tools. Finish the task." }],
    (m) => { events.push(m); if (m.type === "tool") console.log("  ▶", m.name, JSON.stringify(m.args).slice(0, 80)); if (m.type === "assistant") console.log("  💬", m.text.slice(0, 120)); }
  );
  const secs = ((Date.now() - ta) / 1000).toFixed(1);
  const created = fs.existsSync(path.join(WS, "fib.py"));
  const ran = events.some((e) => e.type === "toolResult" && /55/.test(e.result));
  console.log(`\n  fib.py created: ${created ? "✅" : "❌"} | printed 55: ${ran ? "✅" : "❌"} | ${events.filter(e=>e.type==='tool').length} tool calls in ${secs}s`);

  Module._load = origLoad;
  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\n${created && ran ? "🎉 REAL TEST PASSED" : "⚠️ check output above"}`);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
