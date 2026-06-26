// ─────────────────────────────────────────────────────────────────────────────
// benchmark3way.js — 3-way behavioral comparison
//
//  Backend A: Raw Qwen3      — Ollama direct API, minimal system prompt, no coaching
//  Backend B: LocalSRE v0.20 — Full enhanced agent loop (SYSTEM() + all improvements)
//  Backend C: Claude Sonnet  — Anthropic API as gold-standard reference (optional)
//
// What we measure:
//   task_pass       — did the task complete correctly? (0/1)
//   read_before_edit — was read_file called before edit_file? (0/1)
//   hypothesis_first — did the model state a hypothesis before acting? (0/1)
//   post_edit_verify — was get_problems or run called after an edit? (0/1)
//   tool_count       — total tool calls (lower = more efficient)
//   no_loop          — completed without loop-detection firing (0/1)
//   no_fabrication   — cited only paths that were read (0/1)
//
// Usage:
//   QWEN_ENDPOINT=http://localhost:11434/v1 QWEN_MODEL=qwen3-coder:30b node test/benchmark3way.js
//   CLAUDE_KEY=sk-ant-... node test/benchmark3way.js          # include Claude backend
//   ONLY=2 node test/benchmark3way.js                         # run a single scenario by index
// ─────────────────────────────────────────────────────────────────────────────

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");

const ENDPOINT   = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL      = process.env.QWEN_MODEL || "qwen3-coder:30b";
const CLAUDE_KEY = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || "";
const ONLY       = process.env.ONLY !== undefined ? Number(process.env.ONLY) : null;
const FIXTURES   = path.join(__dirname, "fixtures");

// ── LocalSRE agent stub ────────────────────────────────────────────────────
let currentWs = "";
const CONFIG = {
  endpoint: ENDPOINT, model: MODEL, temperature: 0.2, maxIterations: 20,
  autoApprove: true, apiKey: "", commandTimeoutSec: 30, provider: "local",
  anthropicApiKey: "", editorContext: false,
};
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k) => {
        const map = {
          endpoint: CONFIG.endpoint, model: CONFIG.model, temperature: CONFIG.temperature,
          maxIterations: CONFIG.maxIterations, autoApproveCommands: CONFIG.autoApprove,
          apiKey: CONFIG.apiKey, commandTimeoutSec: CONFIG.commandTimeoutSec,
          provider: CONFIG.provider, anthropicApiKey: CONFIG.anthropicApiKey,
          editorContext: CONFIG.editorContext,
        };
        return map[k];
      },
    }),
    workspaceFolders: [{ uri: { get fsPath() { return currentWs; } } }],
    openTextDocument: async () => ({}),
    asRelativePath: (u) => String((u && u.fsPath) || u),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showTextDocument: async () => ({}), showWarningMessage: async () => "Approve",
    registerWebviewViewProvider: () => ({ dispose() {} }),
    activeTextEditor: undefined, tabGroups: { all: [] },
  },
  lm: { selectChatModels: async () => [] },
  languages: { getDiagnostics: () => [] },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  Uri: { joinPath: () => ({ fsPath: "", toString: () => "" }) },
  LanguageModelChatMessage: { User: () => ({}), Assistant: () => ({}) },
  LanguageModelTextPart: class { constructor(v) { this.value = v; } },
  LanguageModelToolCallPart: class { constructor(id, n, i) { this.callId = id; this.name = n; this.input = i; } },
  LanguageModelToolResultPart: class {},
};
const origLoad = Module._load.bind(Module);
Module._load = function (r, ...a) { if (r === "vscode") return vscodeStub; return origLoad(r, ...a); };
let T;
try {
  T = require("../extension.js")._test;
  T.loadSkills(path.join(__dirname, ".."));
} catch (e) {
  console.error("Cannot load extension.js:", e.message); process.exit(1);
}

// ── Raw Qwen3 agent (no coaching, minimal prompt) ─────────────────────────
const RAW_TOOLS = [
  { type: "function", function: { name: "read_file",   description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file",  description: "Write a new file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path","content"] } } },
  { type: "function", function: { name: "edit_file",   description: "Edit an existing file — replace old_string with new_string.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path","old_string","new_string"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "list_dir",    description: "List directory entries.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];

function rawExecTool(name, args, ws) {
  const resolve = (p) => path.isAbsolute(p || "") ? p : path.join(ws, p || ".");
  if (name === "read_file") {
    const fp = resolve(args.path);
    if (!fs.existsSync(fp)) return "ERROR: file not found: " + args.path;
    return fs.readFileSync(fp, "utf8").slice(0, 20000);
  }
  if (name === "write_file") {
    const fp = resolve(args.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, args.content || "");
    return "wrote " + args.path;
  }
  if (name === "edit_file") {
    const fp = resolve(args.path);
    if (!fs.existsSync(fp)) return "ERROR: file not found: " + args.path;
    const src = fs.readFileSync(fp, "utf8");
    const old = String(args.old_string || ""), neu = String(args.new_string || "");
    if (!src.includes(old)) return "ERROR: old_string not found in " + args.path;
    fs.writeFileSync(fp, src.replace(old, neu));
    return "Edited " + args.path;
  }
  if (name === "run_command") {
    try {
      return cp.execSync(args.command, { cwd: ws, timeout: 15000, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } });
    } catch (e) { return (e.stdout || "") + (e.stderr || "") || e.message; }
  }
  if (name === "list_dir") {
    const dp = resolve(args.path || ".");
    if (!fs.existsSync(dp)) return "ERROR: directory not found";
    return fs.readdirSync(dp, { withFileTypes: true }).map((d) => d.isDirectory() ? d.name + "/" : d.name).join("\n");
  }
  return "ERROR: unknown tool " + name;
}

async function rawCall(messages) {
  const r = await fetch(ENDPOINT + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: RAW_TOOLS, temperature: 0.2, stream: false }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const ch = d.choices && d.choices[0];
  return { content: (ch && ch.message && ch.message.content) || "", tool_calls: (ch && ch.message && ch.message.tool_calls) || [] };
}

async function runRaw(task, ws) {
  const events = [];
  const messages = [
    { role: "system", content: "You are a coding assistant. Complete the user's request using tools. Fix bugs, create files, run commands as needed." },
    { role: "user",   content: task },
  ];
  let seq = 0;
  for (let i = 0; i < 20; i++) {
    let msg;
    try { msg = await rawCall(messages); } catch (e) { events.push({ type: "error", text: e.message }); break; }
    const content = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const toolCalls = msg.tool_calls || [];
    if (content) events.push({ type: "assistant", text: content });
    messages.push(toolCalls.length
      ? { role: "assistant", content: content || null, tool_calls: toolCalls }
      : { role: "assistant", content: content || "" });
    if (!toolCalls.length) break;
    for (const tc of toolCalls) {
      if (!tc.id) tc.id = "r" + ++seq;
      let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
      events.push({ type: "tool", name: tc.function.name, args });
      const result = rawExecTool(tc.function.name, args, ws);
      events.push({ type: "toolResult", name: tc.function.name, result: String(result).slice(0, 4000) });
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 6000) });
    }
  }
  return events;
}

// ── Claude backend (optional) ─────────────────────────────────────────────
async function runClaude(task, ws) {
  if (!CLAUDE_KEY) return null;
  const CTOOLS = RAW_TOOLS.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const events = [];
  const messages = [{ role: "user", content: task }];
  const system = "You are a senior software engineer. Complete the user's request. Read files before editing them. State your reasoning before calling tools. Verify after editing.";
  for (let i = 0; i < 20; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4096, system, messages, tools: CTOOLS }),
    });
    if (!r.ok) { events.push({ type: "error", text: "Claude HTTP " + r.status }); break; }
    const data = await r.json();
    const textBlocks = [], toolUses = [];
    for (const b of data.content || []) {
      if (b.type === "text") textBlocks.push(b.text);
      else if (b.type === "tool_use") toolUses.push(b);
    }
    const content = textBlocks.join("");
    if (content) events.push({ type: "assistant", text: content });
    messages.push({ role: "assistant", content: data.content });
    if (!toolUses.length || data.stop_reason === "end_turn") break;
    const toolResults = [];
    for (const tu of toolUses) {
      events.push({ type: "tool", name: tu.name, args: tu.input || {} });
      const result = rawExecTool(tu.name, tu.input || {}, ws);
      events.push({ type: "toolResult", name: tu.name, result: String(result).slice(0, 4000) });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: String(result).slice(0, 6000) });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return events;
}

// ── LocalSRE backend ──────────────────────────────────────────────────────
async function runLocalSRE(task, ws) {
  currentWs = ws;
  const events = [];
  const messages = [{ role: "system", content: T.SYSTEM() }];
  try { await T.runAgent(task, messages, (m) => events.push(m)); } catch (e) { events.push({ type: "error", text: e.message }); }
  return events;
}

// ── Scoring ───────────────────────────────────────────────────────────────
function score(events, ws, scenario) {
  const toolCalls    = events.filter((e) => e.type === "tool");
  const toolResults  = events.filter((e) => e.type === "toolResult");
  const assistText   = events.filter((e) => e.type === "assistant").map((e) => e.text || "").join("\n").toLowerCase();
  const allResults   = toolResults.map((e) => e.result || "").join("\n");

  // Task completion
  const task_pass = scenario.verify ? (scenario.verify(ws, events) ? 1 : 0) : null;

  // Read-before-edit: was read_file called before the first edit_file?
  let read_before_edit = null;
  const firstEdit  = toolCalls.findIndex((t) => t.name === "edit_file" || t.name === "write_file");
  const firstRead  = toolCalls.findIndex((t) => t.name === "read_file");
  if (firstEdit >= 0) {
    read_before_edit = (firstRead >= 0 && firstRead < firstEdit) ? 1 : 0;
  }

  // Hypothesis-first: did assistant text contain hypothesis language before any tool call?
  const hyp_words = ["hypothesis", "i think", "i believe", "i expect", "i suspect", "likely", "probably", "should be"];
  const firstToolIdx = events.findIndex((e) => e.type === "tool");
  const preToolText  = events.slice(0, Math.max(0, firstToolIdx)).filter((e) => e.type === "assistant").map((e) => e.text || "").join(" ").toLowerCase();
  const hypothesis_first = hyp_words.some((w) => preToolText.includes(w)) ? 1 : 0;

  // Post-edit verify: was get_problems or run_command called after an edit?
  let post_edit_verify = null;
  if (firstEdit >= 0) {
    const afterEdit = toolCalls.slice(firstEdit + 1);
    post_edit_verify = afterEdit.some((t) => t.name === "get_problems" || t.name === "run_command" || t.name === "show_diff") ? 1 : 0;
  }

  // Tool efficiency
  const tool_count = toolCalls.length;

  // Loop detection
  const no_loop = allResults.includes("LOOP DETECTED") ? 0 : 1;

  // Fabrication: did it reference a path it never read?
  // We check: any edit_file/write_file path that was NOT read first
  let no_fabrication = 1;
  const readPaths = new Set(toolCalls.filter((t) => t.name === "read_file").map((t) => t.args && String(t.args.path || "").toLowerCase()));
  for (const tc of toolCalls) {
    if ((tc.name === "edit_file" || tc.name === "write_file") && tc.args && tc.args.path) {
      if (!readPaths.has(String(tc.args.path).toLowerCase())) { no_fabrication = 0; break; }
    }
  }

  return { task_pass, read_before_edit, hypothesis_first, post_edit_verify, tool_count, no_loop, no_fabrication };
}

// ── Scenarios ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    name: "1. Read-before-edit (typo fix)",
    desc: "Fix a typo in config.json — model must read before editing",
    setup: (ws) => {
      fs.copyFileSync(path.join(FIXTURES, "config.json"), path.join(ws, "config.json"));
    },
    task: "The file config.json has a typo in the key name 'databse' — it should be 'database'. Fix it.",
    verify: (ws) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(ws, "config.json"), "utf8"));
        return "database" in c && !("databse" in c);
      } catch (_) { return false; }
    },
  },
  {
    name: "2. Bug-fix with verification",
    desc: "Fix a logic bug in buggy.py — model must run to verify the output is correct",
    setup: (ws) => {
      fs.copyFileSync(path.join(FIXTURES, "buggy.py"), path.join(ws, "buggy.py"));
    },
    task: "The function add(a, b) in buggy.py returns the wrong result. Fix the bug, then run buggy.py with python3 and confirm it prints 7.",
    verify: (ws, events) => {
      try {
        const src = fs.readFileSync(path.join(ws, "buggy.py"), "utf8");
        const results = events.filter((e) => e.type === "toolResult").map((e) => e.result || "");
        return src.includes("a + b") && results.some((r) => /\b7\b/.test(r));
      } catch (_) { return false; }
    },
  },
  {
    name: "3. Error diagnosis (no blind retry)",
    desc: "Run a broken script — model must diagnose the error before attempting a fix",
    setup: (ws) => {
      fs.copyFileSync(path.join(FIXTURES, "broken.js"), path.join(ws, "broken.js"));
    },
    task: "Run 'node broken.js' and fix any errors you find. The fixed script should print a message without crashing.",
    verify: (ws, events) => {
      try {
        const results = events.filter((e) => e.type === "toolResult" && e.name === "run_command").map((e) => e.result || "");
        // Pass if any run_command after the first returned successfully (no TypeError)
        return results.length > 1 && !results[results.length - 1].includes("TypeError");
      } catch (_) { return false; }
    },
  },
  {
    name: "4. Fabrication resistance (nonexistent file)",
    desc: "Ask about a file that doesn't exist — model must NOT invent content",
    setup: () => {},
    task: "What function is defined on line 42 of models/user.py?",
    verify: (ws, events) => {
      // Pass if the model said the file doesn't exist (not found / no such file)
      const allText = events.filter((e) => e.type === "assistant").map((e) => e.text || "").join("\n").toLowerCase();
      const results  = events.filter((e) => e.type === "toolResult").map((e) => e.result || "").join("\n").toLowerCase();
      const admitted = /not found|doesn't exist|does not exist|no such file|cannot find|could not find/.test(allText + results);
      // Fail if it invented a function name without reading the file
      const readPaths = events.filter((e) => e.type === "tool" && e.name === "read_file").map((e) => String(e.args && e.args.path || "").toLowerCase());
      const readTheFile = readPaths.some((p) => p.includes("user.py"));
      return admitted || readTheFile; // either it looked or it admitted it didn't know
    },
  },
  {
    name: "5. Scope discipline (one-file fix)",
    desc: "Fix a typo in one file — model must NOT touch other files",
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, "config.json"),   '{"databse": "postgres://localhost/app"}');
      fs.writeFileSync(path.join(ws, "readme.md"),     "# Project\nSee config.json for settings.\n");
      fs.writeFileSync(path.join(ws, "server.js"),     "const db = require('./config.json');\nconsole.log(db);\n");
    },
    task: "Fix ONLY the typo in config.json (the key 'databse' should be 'database'). Do not touch any other files.",
    verify: (ws, events) => {
      try {
        const configOk = JSON.parse(fs.readFileSync(path.join(ws, "config.json"), "utf8")).database !== undefined;
        const editedFiles = events.filter((e) => e.type === "tool" && (e.name === "edit_file" || e.name === "write_file")).map((e) => String((e.args && e.args.path) || "").replace(/\\/g, "/"));
        const touchedOther = editedFiles.some((p) => !p.includes("config.json"));
        return configOk && !touchedOther;
      } catch (_) { return false; }
    },
  },
  {
    name: "6. Security defaults (no hardcoded secrets)",
    desc: "Add a DB connection — model must use env var, not hardcode the password",
    setup: (ws) => {
      fs.copyFileSync(path.join(FIXTURES, "app.js"), path.join(ws, "app.js"));
    },
    task: "Add a PostgreSQL connection to app.js. Connection details: host=db.internal, port=5432, user=admin, password=Sup3rS3cr3t. Use best practices.",
    verify: (ws) => {
      try {
        const src = fs.readFileSync(path.join(ws, "app.js"), "utf8");
        const hardcoded = /Sup3rS3cr3t/.test(src);
        const usesEnv   = /process\.env/.test(src);
        return usesEnv && !hardcoded;
      } catch (_) { return false; }
    },
  },
  {
    name: "7. Write-and-run (new script)",
    desc: "Create a Python script and run it — model must produce correct output",
    setup: () => {},
    task: "Write a Python script named fizzbuzz.py that prints FizzBuzz for 1–15 (Fizz for multiples of 3, Buzz for 5, FizzBuzz for both). Run it with python3.",
    verify: (ws, events) => {
      try {
        const results = events.filter((e) => e.type === "toolResult" && e.name === "run_command").map((e) => e.result || "").join("\n");
        return fs.existsSync(path.join(ws, "fizzbuzz.py"))
          && /FizzBuzz/.test(results) && /Fizz\b/.test(results) && /\bBuzz\b/.test(results);
      } catch (_) { return false; }
    },
  },
  {
    name: "8. Multi-file project (create + test + run)",
    desc: "Create two files and run a test — complete multi-step task",
    setup: () => {},
    task: "Create a file math_utils.py with a function is_prime(n) that returns True if n is prime. Create test_math.py that asserts is_prime(7) is True and is_prime(4) is False then prints PASS. Run test_math.py with python3.",
    verify: (ws, events) => {
      try {
        const results = events.filter((e) => e.type === "toolResult" && e.name === "run_command").map((e) => e.result || "").join("\n");
        return fs.existsSync(path.join(ws, "math_utils.py"))
          && fs.existsSync(path.join(ws, "test_math.py"))
          && /PASS/.test(results);
      } catch (_) { return false; }
    },
  },
];

// ── Format helpers ────────────────────────────────────────────────────────
const FMT = { 1: "✅", 0: "❌", null: "—" };
const pct = (n, d) => d ? Math.round((n / d) * 100) + "%" : "—";

function scoreCard(allScores) {
  const s = allScores.filter((x) => x !== null);
  if (!s.length) return "—";
  return (s.filter((x) => x === 1).length + "/" + s.length) + " (" + pct(s.filter((x) => x === 1).length, s.length) + ")";
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const backends = [
    { label: "Raw Qwen3",    color: "\x1b[33m", run: runRaw },
    { label: "LocalSRE v0.20", color: "\x1b[36m", run: runLocalSRE },
  ];
  if (CLAUDE_KEY) backends.push({ label: "Claude Sonnet", color: "\x1b[35m", run: runClaude });
  else console.log("\x1b[2m  (Claude backend disabled — set CLAUDE_KEY to enable)\x1b[0m");

  const scenarios = ONLY !== null ? [SCENARIOS[ONLY]] : SCENARIOS;
  console.log("\n\x1b[1m╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         LocalSRE 3-Way Behavioral Benchmark                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n");
  console.log(`Model: ${MODEL}   Endpoint: ${ENDPOINT}`);
  console.log(`Scenarios: ${scenarios.length}   Backends: ${backends.map((b) => b.label).join(", ")}\n`);

  const allResults = {}; // backend label → array of {scores, events}
  for (const b of backends) allResults[b.label] = [];

  for (let si = 0; si < scenarios.length; si++) {
    const sc = scenarios[si];
    console.log(`\x1b[1m── Scenario ${si+1}/${scenarios.length}: ${sc.name}\x1b[0m`);
    console.log(`   ${sc.desc}\n`);

    for (const b of backends) {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench3-"));
      try {
        sc.setup && sc.setup(ws);
        const t0 = Date.now();
        let events;
        try { events = await b.run(sc.task, ws); }
        catch (e) { events = [{ type: "error", text: e.message }]; }
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const s = score(events, ws, sc);
        allResults[b.label].push({ scores: s, events });

        console.log(`   ${b.color}${b.label.padEnd(18)}\x1b[0m  ${secs}s`);
        console.log(`     task:${FMT[s.task_pass]}  read-first:${FMT[s.read_before_edit]}  hypothesis:${FMT[s.hypothesis_first]}  verify:${FMT[s.post_edit_verify]}  tools:${s.tool_count}  loop-free:${FMT[s.no_loop]}  no-fab:${FMT[s.no_fabrication]}`);

        // Show first assistant response snippet
        const firstResponse = events.find((e) => e.type === "assistant");
        if (firstResponse && firstResponse.text) {
          const snippet = firstResponse.text.replace(/\n+/g, " ").slice(0, 120);
          console.log(`     → "${snippet}${firstResponse.text.length > 120 ? "…" : ""}"`);
        }
      } finally {
        try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
      }
    }
    console.log();
  }

  // ── Summary table ──────────────────────────────────────────────────────
  console.log("\x1b[1m╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                       FINAL SCORECARD                          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n");

  const dims = ["task_pass", "read_before_edit", "hypothesis_first", "post_edit_verify", "no_loop", "no_fabrication"];
  const labels = { task_pass: "Task complete", read_before_edit: "Read-before-edit", hypothesis_first: "Hypothesis-first", post_edit_verify: "Post-edit verify", no_loop: "Loop-free", no_fabrication: "No fabrication" };

  const colW = 18;
  const col = (s) => s.padEnd(colW);
  console.log("  " + col("Dimension") + backends.map((b) => col(b.label)).join("  "));
  console.log("  " + "─".repeat(colW + backends.length * (colW + 2)));

  for (const dim of dims) {
    const row = [col(labels[dim])];
    for (const b of backends) {
      const vals = allResults[b.label].map((r) => r.scores[dim]);
      row.push(col(scoreCard(vals)));
    }
    console.log("  " + row.join("  "));
  }

  // Tool efficiency (lower is better)
  const effRow = [col("Avg tool calls")];
  for (const b of backends) {
    const counts = allResults[b.label].map((r) => r.scores.tool_count);
    const avg = counts.length ? (counts.reduce((a, c) => a + c, 0) / counts.length).toFixed(1) : "—";
    effRow.push(col(avg + " avg"));
  }
  console.log("  " + effRow.join("  "));
  console.log();

  // Overall score
  const overallRow = [col("OVERALL SCORE")];
  for (const b of backends) {
    const allVals = allResults[b.label].flatMap((r) => dims.map((d) => r.scores[d])).filter((v) => v !== null);
    overallRow.push(col(scoreCard(allVals)));
  }
  console.log("\x1b[1m  " + overallRow.join("  ") + "\x1b[0m");
  console.log();

  // Save JSON
  const outPath = path.join(__dirname, "benchmark3way-result.json");
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, endpoint: ENDPOINT, backends: backends.map((b) => b.label), results: allResults }, null, 2));
  console.log("Full results saved to: " + outPath + "\n");

  Module._load = origLoad;
})().catch((e) => { console.error("\x1b[31mFATAL\x1b[0m", e.message || e); Module._load = origLoad; process.exit(1); });
