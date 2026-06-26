// Tests whether LocalSRE+Qwen3 can WRITE CODE and GENERATE DOCS (not just answer SRE trivia).
// For code tasks: extracts the code block, writes it, and actually RUNS it to verify correctness.
const Module = require("module");
const path = require("path"); const fs = require("fs"); const os = require("os"); const cp = require("child_process");
const ENDPOINT = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.QWEN_MODEL || "qwen3-coder:30b";

const vscodeStub = { workspace: { getConfiguration: () => ({ get: (k) => ({ endpoint: ENDPOINT, model: MODEL, temperature: 0.2, provider: "local" }[k]) }), workspaceFolders: [{ uri: { fsPath: "/tmp" } }], onDidChangeConfiguration: () => ({ dispose() {} }), asRelativePath: (u) => String(u) }, window: { registerWebviewViewProvider: () => ({ dispose() {} }), tabGroups: { all: [] } }, commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }, languages: { getDiagnostics: () => [] }, lm: { selectChatModels: async () => [] }, Uri: { joinPath: () => ({ fsPath: "" }) } };
const origLoad = Module._load.bind(Module);
Module._load = (r, ...a) => (r === "vscode" ? vscodeStub : origLoad(r, ...a));
const T = require("../extension.js")._test; T.loadSkills(path.join(__dirname, ".."));
const SYSTEM = T.SYSTEM();

async function gen(prompt) {
  const t0 = Date.now();
  const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], temperature: 0.2, stream: false, max_tokens: 2048, think: false, enable_thinking: false, keep_alive: "10m" }) });
  const d = await r.json();
  return { text: (d.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), secs: (Date.now() - t0) / 1000 };
}
function extractCode(text, lang) {
  const re = new RegExp("```(?:" + lang + ")?\\s*\\n([\\s\\S]*?)```", "i");
  const m = text.match(re); return m ? m[1].trim() : null;
}
function run(cmd, code, ext) {
  const f = path.join(os.tmpdir(), "cg_" + Math.abs(code.length) + "." + ext);
  fs.writeFileSync(f, code);
  try { return { ok: true, out: cp.execSync(cmd + " " + f, { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || e.message) }; }
  finally { try { fs.unlinkSync(f); } catch (_) {} }
}

const TASKS = [
  { name: "Python: function + unit test", lang: "python", run: "python3",
    prompt: "Write a Python function is_palindrome(s) that ignores case and non-alphanumeric chars, plus 3 assert-based tests. Then call the tests and print PASS if all pass. Return ONE python code block I can run directly.",
    verify: (out) => /PASS/.test(out) },
  { name: "Python: data parsing", lang: "python", run: "python3",
    prompt: "Write a self-contained Python script that defines a list of dicts (3 servers with name and cpu fields), finds the server with highest cpu, and prints 'Highest: <name> at <cpu>%'. Return ONE runnable python code block.",
    verify: (out) => /Highest:/.test(out) },
  { name: "Bash: log-parsing script", lang: "bash", run: "bash",
    prompt: "Write a bash script that creates a sample log file with 5 lines (2 containing ERROR), then counts and prints 'ERROR count: N'. Self-contained, runnable. Return ONE bash code block.",
    verify: (out) => /ERROR count: 2/.test(out) },
  { name: "JS: pure function", lang: "javascript", run: "node",
    prompt: "Write a Node.js script defining function groupBy(arr, key) and demonstrate it grouping [{t:'a',v:1},{t:'b',v:2},{t:'a',v:3}] by 't', printing the result with console.log(JSON.stringify(...)). ONE runnable js code block.",
    verify: (out) => /"a"/.test(out) && /"b"/.test(out) },
  // Doc generation — no execution, judged on structure
  { name: "Docs: README from code", lang: null, run: null,
    prompt: "Here is a function:\n```python\ndef retry(fn, attempts=3, delay=1):\n    for i in range(attempts):\n        try: return fn()\n        except Exception:\n            if i == attempts-1: raise\n            time.sleep(delay)\n```\nWrite concise markdown documentation: a one-line summary, a Parameters section, a Returns section, and a usage Example.",
    verify: (text) => /#|\*\*/.test(text) && /param/i.test(text) && /example/i.test(text) && /return/i.test(text) },
  { name: "Docs: API endpoint doc", lang: null, run: null,
    prompt: "Document a REST endpoint 'POST /api/users' that takes JSON {name, email} and returns 201 with the created user or 400 on validation error. Use markdown with Request, Response, and Errors sections.",
    verify: (text) => /request/i.test(text) && /response/i.test(text) && /40[01]/.test(text) },
];

(async () => {
  console.log(`\n\x1b[1m╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   Can LocalSRE+Qwen3 WRITE CODE & GENERATE DOCS?         ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`Model: ${MODEL}\n`);
  let pass = 0;
  for (const task of TASKS) {
    const { text, secs } = await gen(task.prompt);
    let result, detail = "";
    if (task.run) {
      const code = extractCode(text, task.lang);
      if (!code) { result = false; detail = "no code block found"; }
      else {
        const ext = { python: "py", bash: "sh", javascript: "js" }[task.lang];
        const r = run(task.run, code, ext);
        result = r.ok && task.verify(r.out);
        detail = result ? "compiled & ran, output correct" : (r.ok ? "ran but wrong output: " + r.out.replace(/\n/g, " ").slice(0, 60) : "runtime error: " + r.out.replace(/\n/g, " ").slice(0, 60));
      }
    } else {
      result = task.verify(text);
      detail = result ? "well-structured (" + text.length + " chars)" : "missing required sections";
    }
    if (result) pass++;
    const mark = result ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m";
    console.log(`  ${mark}  ${task.name.padEnd(32)} ${secs.toFixed(1)}s`);
    console.log(`         \x1b[2m${detail}\x1b[0m`);
  }
  console.log(`\n\x1b[1m  SCORE: ${pass}/${TASKS.length} (${Math.round(pass/TASKS.length*100)}%)\x1b[0m\n`);
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
