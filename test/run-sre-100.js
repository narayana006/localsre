// Runs 100 SRE scenarios against LocalSRE v0.21's real SYSTEM() prompt + Ollama.
// Measures: TIME (s), ACCURACY (expected-keyword hits), QUALITY (heuristics).
//
//   QWEN_MODEL=qwen3-coder:30b node test/run-sre-100.js
//   CONCURRENCY=3 node test/run-sre-100.js
//   N=20 node test/run-sre-100.js          # first 20 only (smoke)
const Module = require("module");
const path = require("path");
const fs = require("fs");

const ENDPOINT = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.QWEN_MODEL || "qwen3-coder:30b";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const N = process.env.N ? Number(process.env.N) : 100;

// ── Load the REAL system prompt from extension.js ──
let sessionCwdRef = "/Users/narayana/localsre";
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ endpoint: ENDPOINT, model: MODEL, temperature: 0.2, maxIterations: 20, autoApproveCommands: true, provider: "local" }[k]) }),
    workspaceFolders: [{ uri: { fsPath: sessionCwdRef } }],
    onDidChangeConfiguration: () => ({ dispose() {} }), asRelativePath: (u) => String(u),
  },
  window: { registerWebviewViewProvider: () => ({ dispose() {} }), tabGroups: { all: [] }, activeTextEditor: undefined },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  languages: { getDiagnostics: () => [] }, lm: { selectChatModels: async () => [] },
  Uri: { joinPath: () => ({ fsPath: "" }) },
};
const origLoad = Module._load.bind(Module);
Module._load = (r, ...a) => (r === "vscode" ? vscodeStub : origLoad(r, ...a));
const T = require("../extension.js")._test;
T.loadSkills(path.join(__dirname, ".."));
const SYSTEM = T.SYSTEM();
const SYS_CHARS = SYSTEM.length;

const scenarios = require("./sre-scenarios.js").slice(0, N);

async function ask(scenario) {
  const body = {
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: scenario.q }],
    temperature: 0.2, stream: false, think: false, enable_thinking: false,
    keep_alive: "10m",
  };
  const t0 = Date.now();
  let text = "", err = null;
  try {
    const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    text = (d.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  } catch (e) { err = e.message; }
  const secs = (Date.now() - t0) / 1000;
  return { text, secs, err };
}

function scoreAccuracy(scenario, text) {
  const low = text.toLowerCase();
  const hits = (scenario.expect || []).filter((k) => low.includes(k.toLowerCase()));
  const badHits = (scenario.avoid || []).filter((k) => low.includes(k.toLowerCase()));
  const pass = hits.length >= (scenario.minHits || 1) && badHits.length === 0;
  return { pass, hits: hits.length, need: scenario.minHits || 1, badHits };
}

function scoreQuality(text) {
  // Heuristic quality: has a concrete command/code, reasonable length, explains, not a refusal.
  const hasCommand = /```|`[^`]+`|\bkubectl\b|\bcurl\b|\bgrep\b|\bsystemctl\b|SELECT |\bdig\b|\bdf -|\bdu -/.test(text);
  const hasExplanation = text.split(/[.!?]/).filter((s) => s.trim().length > 15).length >= 1;
  const refusal = /as an ai|i cannot|i can't help|i am unable|i'm just/i.test(text);
  const tooShort = text.length < 20;
  const tooLong = text.length > 2500;
  let q = 0;
  if (hasCommand) q += 2;
  if (hasExplanation) q += 1;
  if (!refusal) q += 1;
  if (!tooShort && !tooLong) q += 1;
  return { q, max: 5, hasCommand, refusal, tooShort, tooLong };
}

(async () => {
  console.log(`\n\x1b[1m╔════════════════════════════════════════════════════════════╗`);
  console.log(`║   LocalSRE v0.21 — 100 SRE Scenario Benchmark              ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`Model: ${MODEL}   System prompt: ${SYS_CHARS} chars (~${Math.round(SYS_CHARS/4)} tokens prefill)`);
  console.log(`Scenarios: ${scenarios.length}   Concurrency: ${CONCURRENCY}\n`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < scenarios.length) {
      const i = idx++;
      const s = scenarios[i];
      const r = await ask(s);
      const acc = scoreAccuracy(s, r.text);
      const qual = scoreQuality(r.text);
      results[i] = { s, r, acc, qual };
      const mark = r.err ? "\x1b[31mERR\x1b[0m" : acc.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[33m✗\x1b[0m";
      const qbar = "█".repeat(qual.q) + "░".repeat(qual.max - qual.q);
      process.stdout.write(`  ${String(s.id).padStart(3)} [${s.cat.padEnd(13)}] ${mark} acc ${acc.hits}/${acc.need}  Q ${qbar}  ${r.secs.toFixed(1)}s\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ── Aggregate ──
  const ok = results.filter((x) => !x.r.err);
  const passed = ok.filter((x) => x.acc.pass).length;
  const avgSecs = ok.reduce((a, x) => a + x.r.secs, 0) / ok.length;
  const avgQ = ok.reduce((a, x) => a + x.qual.q, 0) / ok.length;
  const refusals = ok.filter((x) => x.qual.refusal).length;
  const noCommand = ok.filter((x) => !x.qual.hasCommand).length;
  const slow = ok.filter((x) => x.r.secs > 10).length;

  // by category
  const cats = {};
  for (const x of ok) {
    const c = cats[x.s.cat] || (cats[x.s.cat] = { n: 0, pass: 0, q: 0, secs: 0 });
    c.n++; c.pass += x.acc.pass ? 1 : 0; c.q += x.qual.q; c.secs += x.r.secs;
  }

  console.log(`\n\x1b[1m── RESULTS ──────────────────────────────────────────────────\x1b[0m`);
  console.log(`  Accuracy:     ${passed}/${ok.length}  (${Math.round(passed/ok.length*100)}%)`);
  console.log(`  Avg quality:  ${avgQ.toFixed(2)}/5`);
  console.log(`  Avg time:     ${avgSecs.toFixed(1)}s   (slowest>10s: ${slow})`);
  console.log(`  Refusals:     ${refusals}   No-command answers: ${noCommand}   Errors: ${results.length - ok.length}`);

  console.log(`\n\x1b[1m── BY CATEGORY ──────────────────────────────────────────────\x1b[0m`);
  console.log(`  ${"category".padEnd(15)} ${"acc".padEnd(10)} ${"quality".padEnd(9)} avg-time`);
  for (const [c, v] of Object.entries(cats).sort((a, b) => (a[1].pass/a[1].n) - (b[1].pass/b[1].n))) {
    const accPct = Math.round(v.pass / v.n * 100);
    const col = accPct >= 80 ? "\x1b[32m" : accPct >= 60 ? "\x1b[33m" : "\x1b[31m";
    console.log(`  ${c.padEnd(15)} ${col}${(v.pass+"/"+v.n).padEnd(6)}${(accPct+"%").padEnd(4)}\x1b[0m ${(v.q/v.n).toFixed(2)}/5    ${(v.secs/v.n).toFixed(1)}s`);
  }

  // worst failures for inspection
  console.log(`\n\x1b[1m── FAILURES (what needs improvement) ────────────────────────\x1b[0m`);
  const fails = ok.filter((x) => !x.acc.pass).slice(0, 15);
  for (const x of fails) {
    console.log(`  \x1b[33m#${x.s.id} [${x.s.cat}]\x1b[0m ${x.s.q.slice(0, 70)}`);
    console.log(`     wanted ${x.s.minHits||1} of: [${(x.s.expect||[]).slice(0,5).join(", ")}]${x.acc.badHits.length?"  BAD: "+x.acc.badHits.join(","):""}`);
    console.log(`     got: \x1b[2m${x.r.text.replace(/\n+/g," ").slice(0, 110)}\x1b[0m`);
  }

  const out = path.join(__dirname, "sre-100-result.json");
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, sysChars: SYS_CHARS, summary: { passed, total: ok.length, avgSecs, avgQ, refusals, noCommand }, cats, results: results.map((x) => ({ id: x.s.id, cat: x.s.cat, q: x.s.q, pass: x.acc.pass, hits: x.acc.hits, quality: x.qual.q, secs: x.r.secs, answer: x.r.text })) }, null, 2));
  console.log(`\nFull results → ${out}\n`);
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
