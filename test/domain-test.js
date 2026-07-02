// domain-test.js — targeted test for the user's REAL toolchain:
// GitHub Actions (workflows, cron, gh CLI), BigQuery, GKE, Google Sheets.
// Generation tasks are STRUCTURALLY VALIDATED (YAML parsed, cron checked), not just keyword-matched.
//
//   QWEN_MODEL=qwen3-coder:fast node test/domain-test.js
const Module = require("module");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const ENDPOINT = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.QWEN_MODEL || "qwen3-coder:fast";

const vscodeStub = { workspace: { getConfiguration: () => ({ get: (k) => ({ endpoint: ENDPOINT, model: MODEL, temperature: 0.2, provider: "local", memoryPaths: [] }[k]) }), workspaceFolders: [{ uri: { fsPath: "/tmp" } }], onDidChangeConfiguration: () => ({ dispose() {} }), asRelativePath: (u) => String(u) }, window: { registerWebviewViewProvider: () => ({ dispose() {} }), tabGroups: { all: [] } }, commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }, languages: { getDiagnostics: () => [] }, lm: { selectChatModels: async () => [] }, Uri: { joinPath: () => ({ fsPath: "" }) } };
const origLoad = Module._load.bind(Module);
Module._load = (r, ...a) => (r === "vscode" ? vscodeStub : origLoad(r, ...a));
const T = require("../extension.js")._test;
T.loadSkills(path.join(__dirname, ".."));
const SYSTEM = T.SYSTEM();

async function gen(prompt) {
  const t0 = Date.now();
  const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], temperature: 0.2, stream: false, max_tokens: 2048, keep_alive: "10m" }) });
  const d = await r.json();
  return { text: (d.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), secs: (Date.now() - t0) / 1000 };
}
function block(text, lang) { const m = text.match(new RegExp("```(?:" + (lang || "[a-z]*") + ")?\\s*\\n([\\s\\S]*?)```", "i")); return m ? m[1].trim() : null; }
const kw = (text, words, min) => words.filter((w) => text.toLowerCase().includes(w.toLowerCase())).length >= min;

const TASKS = [
  // ── GitHub Actions: generation, structurally validated ──
  { name: "GHA: nightly cron workflow (structure + cron correct)", cat: "gha",
    prompt: "Write a GitHub Actions workflow that runs nightly at 2am UTC on the main branch and executes `make test`. Return ONE yaml code block only.",
    verify: (t) => { const y = block(t, "yaml") || block(t); if (!y) return false;
      return /schedule:/.test(y) && /cron:\s*['"]?0 2 \* \* \*['"]?/.test(y) && /^jobs:/m.test(y) && /make test/.test(y); } },
  { name: "GHA: matrix build workflow (structure + matrix present)", cat: "gha",
    prompt: "Write a GitHub Actions workflow that tests on node 18 and 20 using a matrix strategy, triggered on pull_request. ONE yaml code block.",
    verify: (t) => { const y = block(t, "yaml") || block(t); if (!y) return false;
      return /pull_request/.test(y) && /matrix:/.test(y) && /18/.test(y) && /20/.test(y) && /matrix\.node|matrix\.version|matrix\./.test(y); } },
  { name: "GHA: workflow_dispatch with typed input", cat: "gha",
    prompt: "Write a GitHub Actions workflow with a manual workflow_dispatch trigger that takes an input `environment` (choice: dev, prod) and echoes it. ONE yaml code block.",
    verify: (t) => { const y = block(t, "yaml") || block(t); if (!y) return false;
      return /workflow_dispatch:/.test(y) && /inputs:/.test(y) && /environment:/.test(y) && /dev/.test(y) && /prod/.test(y); } },
  { name: "cron: every weekday 9:30am expression", cat: "gha",
    prompt: "What is the cron expression for every weekday (Mon-Fri) at 9:30 AM? Answer with the expression.",
    verify: (t) => /30\s+9\s+\*\s+\*\s+(1-5|MON-FRI)/i.test(t) },
  { name: "gh CLI: list failed runs", cat: "gha",
    prompt: "Which gh CLI command lists the failed workflow runs in the current repo?",
    verify: (t) => kw(t, ["gh run list"], 1) && kw(t, ["--status failure", "--status=failure", "failure"], 1) },
  { name: "gh CLI: rerun only failed jobs", cat: "gha",
    prompt: "How do I rerun only the failed jobs of GitHub Actions run 123456 with gh?",
    verify: (t) => kw(t, ["gh run rerun"], 1) && kw(t, ["--failed"], 1) },
  { name: "GHA: schedule caveats (UTC + delays)", cat: "gha",
    prompt: "My GitHub Actions cron job runs at the wrong time and sometimes late. Why?",
    verify: (t) => kw(t, ["UTC"], 1) && kw(t, ["delay", "not guaranteed", "high load", "queue", "busy", "exact"], 1) },
  { name: "GHA: secrets usage in workflow", cat: "gha",
    prompt: "How do I use a repository secret named GCP_SA_KEY inside a GitHub Actions step?",
    verify: (t) => kw(t, ["secrets.GCP_SA_KEY"], 1) },

  // ── BigQuery ──
  { name: "BQ: estimate cost before running", cat: "bq",
    prompt: "How do I estimate how many bytes a BigQuery query will scan before actually running it (CLI)?",
    verify: (t) => kw(t, ["--dry_run", "dry run", "dryRun"], 1) },
  { name: "BQ: dedupe latest row per key (SQL)", cat: "bq",
    prompt: "Write BigQuery standard SQL to keep only the latest row per user_id from table `p.d.events` using the ts column. ONE sql code block.",
    verify: (t) => kw(t, ["ROW_NUMBER", "QUALIFY", "PARTITION BY"], 2) && kw(t, ["user_id"], 1) },
  { name: "BQ: load CSV from GCS", cat: "bq",
    prompt: "Give the bq CLI command to load gs://bucket/data.csv into dataset.table with autodetected schema, skipping the header row.",
    verify: (t) => kw(t, ["bq load"], 1) && kw(t, ["--autodetect"], 1) && kw(t, ["--skip_leading_rows", "skip_leading_rows=1"], 1) },
  { name: "BQ: partitioned table cost control", cat: "bq",
    prompt: "My BigQuery query on a date-partitioned table scans the whole table. How do I make it scan only yesterday's partition?",
    verify: (t) => kw(t, ["WHERE", "_PARTITIONDATE", "_PARTITIONTIME", "partition column", "date ="], 1) },

  // ── GKE ──
  { name: "GKE: get cluster credentials", cat: "gke",
    prompt: "What command configures kubectl to talk to the GKE cluster `prod-1` in zone us-east1-b?",
    verify: (t) => kw(t, ["gcloud container clusters get-credentials"], 1) && kw(t, ["prod-1"], 1) },
  { name: "GKE: resize node pool", cat: "gke",
    prompt: "How do I resize the default-pool of GKE cluster prod-1 to 5 nodes (CLI)?",
    verify: (t) => kw(t, ["gcloud container clusters resize"], 1) && kw(t, ["--num-nodes", "num-nodes"], 1) },
  { name: "GKE: pods Pending, autoscaler not scaling", cat: "gke",
    prompt: "Pods are Pending on GKE and the cluster autoscaler isn't adding nodes. Name the two most likely causes.",
    verify: (t) => kw(t, ["max", "maximum", "limit"], 1) && kw(t, ["resource", "requests", "quota", "machine type", "doesn't fit", "constraint", "taint", "affinity"], 1) },
  { name: "GKE: workload identity for pod → GCP auth", cat: "gke",
    prompt: "What is the recommended way for a GKE pod to authenticate to Google Cloud APIs without JSON key files?",
    verify: (t) => kw(t, ["workload identity"], 1) },

  // ── Google Sheets ──
  { name: "Sheets: read a range with Python", cat: "sheets",
    prompt: "Show minimal Python to read range Sheet1!A1:C10 from a Google Sheet by spreadsheet ID using the Sheets API. ONE python code block.",
    verify: (t) => { const c = block(t, "python") || ""; return /spreadsheets\(\)\.values\(\)\.get|gspread/.test(c) && /A1:C10|Sheet1/.test(c); } },
  { name: "Sheets: service account access", cat: "sheets",
    prompt: "My service account gets 403 reading a Google Sheet via API. What's the most common fix?",
    verify: (t) => kw(t, ["share", "shared"], 1) && kw(t, ["service account", "client_email", "iam.gserviceaccount.com"], 1) },
  { name: "Sheets: append rows via API", cat: "sheets",
    prompt: "Which Sheets API method appends rows to the end of a sheet, and what valueInputOption should I usually use?",
    verify: (t) => kw(t, ["append"], 1) && kw(t, ["USER_ENTERED", "RAW"], 1) },
];

(async () => {
  console.log(`\n\x1b[1m╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Domain test: GHA / cron / gh / BigQuery / GKE / Sheets       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`Model: ${MODEL}   System prompt: ${SYSTEM.length} chars\n`);
  const cats = {};
  let pass = 0;
  for (const task of TASKS) {
    let text = "", secs = 0, ok = false, err = "";
    try { ({ text, secs } = await gen(task.prompt)); ok = !!task.verify(text); }
    catch (e) { err = e.message; }
    if (ok) pass++;
    const c = cats[task.cat] || (cats[task.cat] = { n: 0, p: 0 }); c.n++; if (ok) c.p++;
    console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} [${task.cat.padEnd(6)}] ${task.name.padEnd(52)} ${secs.toFixed(1)}s${err ? "  ERR: " + err : ""}`);
    if (!ok && !err) console.log(`      \x1b[2m${text.replace(/\n+/g, " ").slice(0, 110)}\x1b[0m`);
  }
  console.log(`\n\x1b[1m  BY DOMAIN:\x1b[0m`);
  for (const [c, v] of Object.entries(cats)) console.log(`    ${c.padEnd(8)} ${v.p}/${v.n}`);
  console.log(`\x1b[1m  TOTAL: ${pass}/${TASKS.length} (${Math.round(pass / TASKS.length * 100)}%)\x1b[0m\n`);
  fs.writeFileSync(path.join(__dirname, "domain-test-result.json"), JSON.stringify({ model: MODEL, pass, total: TASKS.length, cats }, null, 2));
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
