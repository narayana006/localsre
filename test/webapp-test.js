// Can LocalSRE+Qwen3 build HTML dashboards, React, and Angular apps?
// HTML is validated structurally (and rendered headlessly if node can parse it).
const Module = require("module");
const path = require("path"); const fs = require("fs");
const ENDPOINT = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.QWEN_MODEL || "qwen3-coder:30b";
const vscodeStub = { workspace: { getConfiguration: () => ({ get: (k) => ({ endpoint: ENDPOINT, model: MODEL, temperature: 0.2, provider: "local" }[k]) }), workspaceFolders: [{ uri: { fsPath: "/tmp" } }], onDidChangeConfiguration: () => ({ dispose() {} }), asRelativePath: (u) => String(u) }, window: { registerWebviewViewProvider: () => ({ dispose() {} }), tabGroups: { all: [] } }, commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }, languages: { getDiagnostics: () => [] }, lm: { selectChatModels: async () => [] }, Uri: { joinPath: () => ({ fsPath: "" }) } };
const origLoad = Module._load.bind(Module);
Module._load = (r, ...a) => (r === "vscode" ? vscodeStub : origLoad(r, ...a));
const T = require("../extension.js")._test; T.loadSkills(path.join(__dirname, ".."));
const SYSTEM = T.SYSTEM();
async function gen(prompt) {
  const t0 = Date.now();
  const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], temperature: 0.2, stream: false, max_tokens: 3000, think: false, enable_thinking: false, keep_alive: "10m" }) });
  const d = await r.json();
  return { text: (d.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), secs: (Date.now() - t0) / 1000 };
}
function code(text, lang) { const m = text.match(new RegExp("```(?:" + (lang || "[a-z]*") + ")?\\s*\\n([\\s\\S]*?)```", "i")); return m ? m[1].trim() : text; }

const TASKS = [
  { name: "HTML dashboard (chart + cards)",
    prompt: "Build a single self-contained index.html SRE metrics dashboard: 3 metric cards (CPU, Memory, Error Rate) and one bar chart drawn on a <canvas> with vanilla JS (no external libs). Inline CSS for a dark theme. Return ONE html code block.",
    verify: (t) => { const h = code(t, "html").toLowerCase(); return h.includes("<canvas") && h.includes("getcontext") && (h.match(/card/g)||[]).length >= 2 && h.includes("<style"); } },
  { name: "HTML + fetch live data",
    prompt: "Write a self-contained dashboard.html that fetches JSON from '/api/metrics' every 5s with fetch() and updates a table of pods (name, status, restarts). Vanilla JS, no libraries. Return ONE html code block.",
    verify: (t) => { const h = code(t, "html").toLowerCase(); return h.includes("fetch(") && (h.includes("setinterval") || h.includes("5000")) && h.includes("<table"); } },
  { name: "React component (hooks)",
    prompt: "Write a React functional component ServiceHealth that uses useState and useEffect to fetch '/api/health' and render a list of services with a green/red status dot. Include export. Return ONE jsx code block.",
    verify: (t) => { const c = code(t, "jsx"); return /useState/.test(c) && /useEffect/.test(c) && /export/.test(c) && /return\s*\(/.test(c); } },
  { name: "React + props + map",
    prompt: "Write a React component MetricGrid that takes a prop `metrics` (array of {label,value,unit}) and renders them as a responsive grid of cards. Use export default. Return ONE jsx code block.",
    verify: (t) => { const c = code(t, "jsx"); return /export default/.test(c) && /\.map\(/.test(c) && /props|\{metrics\}|metrics/.test(c); } },
  { name: "Angular component",
    prompt: "Write an Angular component (TypeScript) AlertListComponent with @Component decorator, an inline template showing *ngFor over an alerts array of {severity,message}, and a typed alerts property. Return ONE typescript code block.",
    verify: (t) => { const c = code(t, "typescript"); return /@Component/.test(c) && /\*ngFor/.test(c) && /export class/.test(c); } },
  { name: "Vue SFC dashboard",
    prompt: "Write a Vue 3 single-file component (<template>/<script setup>/<style>) showing a uptime percentage and a list of incidents. Return ONE vue code block.",
    verify: (t) => { const c = code(t, "vue"); return /<template>/.test(c) && /<script/.test(c) && /(v-for|setup)/.test(c); } },
];
(async () => {
  console.log(`\n\x1b[1m╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   Can LocalSRE+Qwen3 build DASHBOARDS / React / Angular?  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`Model: ${MODEL}\n`);
  let pass = 0;
  for (const task of TASKS) {
    let text = "", secs = 0;
    try { ({ text, secs } = await gen(task.prompt)); } catch (e) { console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${task.name.padEnd(34)} fetch error: ${e.message}`); continue; }
    const ok = task.verify(text);
    if (ok) pass++;
    console.log(`  ${ok ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m"}  ${task.name.padEnd(34)} ${secs.toFixed(1)}s  (${text.length} chars)`);
    if (!ok) console.log(`         \x1b[2m${text.replace(/\n+/g," ").slice(0,90)}\x1b[0m`);
  }
  console.log(`\n\x1b[1m  SCORE: ${pass}/${TASKS.length} (${Math.round(pass/TASKS.length*100)}%)\x1b[0m\n`);
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
