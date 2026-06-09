// Regression certification: multi-turn scenario against the LIVE local model (Ollama qwen3-coder).
// Interleaves NEW tasks with CONTEXT-RECALL prompts, then simulates a NEW SESSION (fresh messages,
// memory file reloaded) to certify persistent memory. Also checks it doesn't go rogue.
// Usage: QWEN_ENDPOINT=http://localhost:11434/v1 QWEN_MODEL=qwen3-coder:30b node test/regression.js
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

let WS = fs.mkdtempSync(path.join(os.tmpdir(), "regr-"));
const CONFIG = {
  endpoint: process.env.QWEN_ENDPOINT || "http://localhost:11434/v1",
  model: process.env.QWEN_MODEL || "qwen3-coder:30b", temperature: 0.2, maxIterations: 15,
  autoApprove: true, apiKey: "", commandTimeoutSec: 60, provider: "local", anthropicApiKey: "", editorContext: false,
};
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k) => CONFIG[k] }), workspaceFolders: [{ uri: { get fsPath() { return WS; } } }], openTextDocument: async () => ({}), asRelativePath: (u) => String((u && u.fsPath) || u) },
  window: { showTextDocument: async () => ({}), showWarningMessage: async () => "Approve", registerWebviewViewProvider: () => ({ dispose() {} }), activeTextEditor: undefined, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};
const origLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };
const T = require("../extension.js")._test;
T.loadSkills(path.join(__dirname, ".."));

const allText = (ev) => ev.filter((e) => e.type === "assistant").map((e) => e.text).join("\n");
const toolResults = (ev) => ev.filter((e) => e.type === "toolResult").map((e) => e.result || "").join("\n");
const toolNames = (ev) => ev.filter((e) => e.type === "tool").map((e) => e.name);

let pass = 0, fail = 0;
const results = [];
function grade(name, cond, detail) {
  (cond ? pass++ : fail++);
  results.push({ name, cond });
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? "  [" + detail.slice(0, 80) + "]" : ""}`);
}

async function turn(messages, text) {
  const events = [];
  try { await T.runAgent(text, messages, (m) => events.push(m)); } catch (e) { events.push({ type: "assistant", text: "ERR " + e.message }); }
  return events;
}

(async () => {
  console.log("workspace:", WS, "| model:", CONFIG.model);

  // ============ SESSION 1 ============
  console.log("\n--- SESSION 1: tasks + in-session recall ---");
  let messages = [{ role: "system", content: T.SYSTEM() }];

  // T1: new task
  let ev = await turn(messages, "Create a file service.py with a function port() that returns 8443. Run it with python3 to print port(). Also REMEMBER: our payment service is called 'paysvc-prod' and runs in namespace 'payments'.");
  grade("T1 task: service.py created", fs.existsSync(path.join(WS, "service.py")));
  grade("T1 output shows 8443", /8443/.test(toolResults(ev)));
  grade("T1 saved fact to memory (remember tool)", toolNames(ev).includes("remember") && fs.existsSync(path.join(WS, ".localsre", "memory.md")), toolNames(ev).join(","));

  // T2: unrelated new task
  ev = await turn(messages, "Now create util.py with a function double(x) returning x*2 and run it printing double(21).");
  grade("T2 task: util.py + 42", fs.existsSync(path