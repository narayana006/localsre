// Comparative agentic eval: runs the SAME graded tasks through the extension's real agent loop
// against whatever model is serving on the endpoint. Run once per model, compare the scorecards.
// Usage: QWEN_ENDPOINT=http://localhost:8080/v1 QWEN_LABEL="30B" node test/compare.js
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

let WS = "";
const CONFIG = {
  endpoint: process.env.QWEN_ENDPOINT || "http://localhost:8080/v1",
  model: process.env.QWEN_MODEL || "model", temperature: 0.2, maxIterations: 20,
  autoApprove: true, apiKey: "", commandTimeoutSec: 60, provider: "local", anthropicApiKey: "",
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

const out = (e) => e.type === "toolResult" ? (e.result || "") : "";
const ranOut = (events) => events.filter((e) => e.type === "toolResult").map((e) => e.result || "").join("\n");

const TASKS = [
  { name: "1.fib (baseline)",
    prompt: "Create fib.py with an iterative fib(n) returning the nth Fibonacci number, then run it with python3 to print fib(10). Output must be 55.",
    verify: (ws, ev) => fs.existsSync(path.join(ws, "fib.py")) && /(^|\D)55(\D|$)/.test(ranOut(ev)) },
  { name: "2.multi-file+test",
    prompt: "Create calc.py with add(a,b) and sub(a,b). Create test_calc.py that asserts add(2,3)==5 and sub(5,2)==3 then prints OK. Run test_calc.py with python3 and confirm it prints OK.",
    verify: (ws, ev) => fs.existsSync(path.join(ws, "calc.py")) && fs.existsSync(path.join(ws, "test_calc.py")) && /\bOK\b/.test(ranOut(ev)) },
  { name: "3.bug-fix (read+edit)",
    setup: (ws) => fs.writeFileSync(path.join(ws, "buggy.py"), "def biggest(a, b):\n    if a > b:\n        return b\n    return a\n\nprint(biggest(3, 7))\n"),
    prompt: "buggy.py has a function biggest(a,b) that should return the larger number but returns the wrong one. Fix the bug, then run buggy.py with python3 — it must print 7.",
    verify: (ws, ev) => /(^|\D)7(\D|$)/.test(ranOut(ev)) },
  { name: "4.logic (wordcount)",
    prompt: "Write wc.py that counts word frequency in the string 'the cat sat on the mat the cat' and prints the most frequent word and its count separated by a space. Run it; it must print: the 3",
    verify: (ws, ev) => /the\s+3/.test(ranOut(ev)) },
  { name: "5.refactor across uses",
    setup: (ws) => fs.writeFileSync(path.join(ws, "app.py"), "def greet(n):\n    return 'hi ' + n\n\nprint(greet('a'))\nprint(greet('b'))\n"),
    prompt: "In app.py, rename the function greet to welcome everywhere it is used, then run app.py with python3 — it must still print 'hi a' then 'hi b' (two lines).",
    verify: (ws, ev) => { try { const s = fs.readFileSync(path.join(ws, "app.py"), "utf8"); return s.includes("def welcome") && !s.includes("def greet") && /hi a/.test(ranOut(ev)); } catch (_) { return false; } } },
];

(async () => {
  const label = process.env.QWEN_LABEL || "model";
  // speed probe
  let tps = "?";
  try {
    const t0 = Date.now();
    const r = await fetch(CONFIG.endpoint + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: CONFIG.model, messages: [{ role: "user", content: "Reply with exactly 30 words about reliability." }], temperature: 0.2, stream: false }) });
    const d = await r.json(); const dt = (Date.now() - t0) / 1000;
    const tk = d.usage ? d.usage.completion_tokens : (d.choices[0].message.content || "").split(/\s+/).length;
    tps = (tk / dt).toFixed(1);
  } catch (_) {}

  const results = [];
  for (const task of TASKS) {
    WS = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
    if (task.setup) task.setup(WS);
    const events = [];
    const messages = [{ role: "system", content: T.SYSTEM() }];
    const t0 = Date.now();
    try { await T.runAgent(task.prompt, messages, (m) => events.push(m)); } catch (e) { events.push({ type: "toolResult", result: "ERR " + e.message }); }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const toolCalls = events.filter((e) => e.type === "tool").length;
    const looped = events.some((e) => /LOOP DETECTED/.test(out(e)));
    const pass = !!task.verify(WS, events);
    results.push({ name: task.name, pass, toolCalls, looped, secs });
    fs.rmSync(WS, { recursive: true, force: true });
    console.log(`  ${pass ? "✅" : "❌"} ${task.name} — tools:${toolCalls} ${looped ? "LOOPED " : ""}${secs}s`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[[RESULT]] label=${label} speed=${tps}tok/s passed=${passed}/${TASKS.length} loops=${results.filter((r) => r.looped).length} totaltools=${results.reduce((a, r) => a + r.toolCalls, 0)}`);
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
