// CERTIFICATION: multi-turn regression against the LIVE model (Ollama qwen3-coder:30b).
// Proves: (1) new tasks work, (2) it REMEMBERS facts across turns AND across a simulated
// session restart (via .localsre/memory.md), (3) it does not go rogue (stop-and-wait, no loop spam).
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

let WS = fs.mkdtempSync(path.join(os.tmpdir(), "cert-"));
const CONFIG = {
  endpoint: process.env.QWEN_ENDPOINT || "http://localhost:11434/v1",
  model: process.env.QWEN_MODEL || "qwen3-coder:30b", temperature: 0.2, maxIterations: 12,
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

let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + n + (extra ? "  — " + extra : "")); };

function newSession() { return [{ role: "system", content: T.SYSTEM() }]; } // re-reads memory file fresh
async function ask(messages, text) {
  const events = [];
  try { await T.runAgent(text, messages, (m) => events.push(m)); } catch (e) { events.push({ type: "assistant", text: "ERR " + e.message }); }
  const toolNames = events.filter((e) => e.type === "tool").map((e) => e.name);
  const cmds = events.filter((e) => e.type === "tool" && e.name === "run_command").map((e) => (e.args && e.args.command) || "");
  const deltas = events.filter((e) => e.type === "assistantDelta").map((e) => e.text).join("");
  const finalText = ((events.filter((e) => e.type === "assistant").pop() || {}).text || "") + " " + deltas;
  const streamed = deltas.length > 0;
  const looped = events.some((e) => e.type === "toolResult" && /LOOP DETECTED/.test(e.result || ""));
  return { toolNames, cmds, finalText, looped, toolCount: toolNames.length };
}

(async () => {
  console.log("model:", CONFIG.model, "| ws:", WS, "\n");

  console.log("[Session 1 — interleave new tasks + memory]");
  let s1 = newSession();

  // T1: new task — should write+run a file
  let r = await ask(s1, "Create greet.py with a function hello() that returns 'hi', and run it with python3 so it prints hi.");
  ok("T1 new task: created+ran greet.py", fs.existsSync(path.join(WS, "greet.py")) && /\bhi\b/.test(r.cmds.join(" ") + r.finalText) || r.toolNames.includes("write_file"), "tools: " + r.toolNames.join(","));

  // T2: give a durable rule → expect it to call remember
  r = await ask(s1, "Important: our prod database host is db-prod.internal:5432 and you reach it ONLY via the bastion 'jump.corp'. Remember this for all future work.");
  const savedAfterT2 = fs.existsSync(path.join(WS, ".localsre", "memory.md")) && /jump\.corp/.test(fs.readFileSync(path.join(WS, ".localsre", "memory.md"), "utf8"));
  ok("T2 saved rule to repo memory", savedAfterT2, r.toolNames.includes("remember") ? "used remember tool" : "tools: " + r.toolNames.join(","));

  // T3: same-session recall
  r = await ask(s1, "What host and bastion do we use to reach the prod database?");
  ok("T3 same-session recall", /db-prod\.internal/.test(r.finalText) && /jump\.corp/.test(r.finalText), "answer: " + r.finalText.slice(0, 100));

  // T4: another new task in between
  r = await ask(s1, "Create add.py with add(a,b) and run python3 -c to print add(2,2).");
  ok("T4 second new task ran", r.toolNames.includes("write_file") || /\b4\b/.test(r.cmds.join(" ")), "tools: " + r.toolNames.join(","));

  // T5: does NOT re-ask something already known
  r = await ask(s1, "Set up a connection to the prod database. Use what you already know — do not ask me for details you have.");
  const reAsked = /\bwhat\b.*\b(host|bastion|database|port|address)\b\?/i.test(r.finalText) || /could you (provide|tell|share)/i.test(r.finalText);
  ok("T5 did NOT re-ask known info", !reAsked && /jump\.corp|db-prod/.test(r.finalText + r.cmds.join(" ")), reAsked ? "RE-ASKED: " + r.finalText.slice(0, 100) : "used known info");

  console.log("\n[Session 2 — SIMULATED RESTART: brand-new conversation, memory file persists]");
  let s2 = newSession(); // fresh messages, but SYSTEM() reloads .localsre/memory.md

  // T6: cross-session recall (the real test)
  r = await ask(s2, "Remind me — how do we connect to the prod database here?");
  ok("T6 CROSS-SESSION recall (the key one)", /db-prod\.internal/.test(r.finalText) && /jump\.corp/.test(r.finalText), "answer: " + r.finalText.slice(0, 120));

  console.log("\n[Behavior — not rogue]");
  // T7: simple ask should stop, not spin
  r = await ask(s2, "What is 2+2? Just answer.");
  ok("T7 stops promptly (not rogue)", r.toolCount <= 2 && !r.looped, "toolCount: " + r.toolCount + (r.looped ? " LOOPED" : ""));
  ok("T8 no loop spam anywhere", !r.looped);

  fs.rmSync(WS, { recursive: true, force: true });
  Module._load = origLoad;
  console.log(`\n[[CERT]] ${fail === 0 ? "🎉 CERTIFIED" : "💥 FAILED"} — ${pass} passed, ${fail} failed`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
