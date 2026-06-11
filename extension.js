// LocalSRE — lightweight local agentic coding assistant for VS Code.
// Talks to a local OpenAI-compatible server (llama.cpp `llama-server --jinja`)
// and drives a local model (Qwen3-Coder / DeepSeek-Coder-V2-Lite / DeepSeek-R1)
// through a real tool-calling agent loop with a skills system.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- config ----------
function cfg() {
  const c = vscode.workspace.getConfiguration("localsre");
  return {
    endpoint: (c.get("endpoint") || "http://localhost:11434/v1").replace(/\/+$/, ""), // Ollama by default
    model: c.get("model") || "qwen3-coder",
    temperature: Number.isFinite(c.get("temperature")) ? c.get("temperature") : 0.2,
    maxIterations: Number(c.get("maxIterations")) > 0 ? Number(c.get("maxIterations")) : 50,
    autoApprove: !!c.get("autoApproveCommands"),
    apiKey: c.get("apiKey") || "",
    provider: c.get("provider") || "local",
    anthropicApiKey: c.get("anthropicApiKey") || "",
    editorContext: !!c.get("editorContext"), // off by default — it can distract local models
  };
}

function wsRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : process.cwd();
}
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(wsRoot(), p || ".");
}

// What the user is currently looking at — active file, selection, open tabs — so "this/here" works.
function editorContext() {
  try {
    const lines = [];
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document) {
      lines.push("Active file: " + vscode.workspace.asRelativePath(ed.document.uri));
      const sel = ed.selection;
      if (sel && !sel.isEmpty) {
        lines.push("Selected (lines " + (sel.start.line + 1) + "-" + (sel.end.line + 1) + "):\n" + ed.document.getText(sel).slice(0, 2000));
      } else if (ed.selection) {
        lines.push("Cursor at line " + (ed.selection.active.line + 1) + " (no selection).");
      }
    }
    const tabs = [];
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (t.input && t.input.uri) tabs.push(vscode.workspace.asRelativePath(t.input.uri));
    const uniq = Array.from(new Set(tabs)).slice(0, 15);
    if (uniq.length) lines.push("Open tabs: " + uniq.join(", "));
    return lines.length ? "[Editor context — what the user is currently looking at]\n" + lines.join("\n") : "";
  } catch (_) { return ""; }
}
function withEditorContext(text) {
  if (!cfg().editorContext) return text; // opt-in — off by default (it can distract local models)
  const ctx = editorContext();
  return ctx ? ctx + "\n\n[User request]\n" + text : text;
}
function cmdTimeoutMs() {
  return (vscode.workspace.getConfiguration("localsre").get("commandTimeoutSec") || 900) * 1000;
}
// A spawned shell lacks the login PATH, so brew/pip/npm wouldn't be found. Add the usual bins.
function execEnv() {
  const home = process.env.HOME || "";
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin",
    path.join(home, ".local/bin"), path.join(home, "bin")];
  const PATH = Array.from(new Set([...extra, ...(process.env.PATH || "").split(":")])).filter(Boolean).join(":");
  return { ...process.env, PATH, HOMEBREW_NO_AUTO_UPDATE: "1" };
}
function clip(s, n = 30000) {
  return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
}
// (4) Distill long tool output: keep the HEAD and the TAIL (errors/results usually live at the end)
// so the relevant signal survives into context instead of being chopped to just the top.
function distill(s, n = 6000) {
  s = String(s);
  if (s.length <= n) return s;
  const head = s.slice(0, Math.floor(n * 0.6));
  const tail = s.slice(-Math.floor(n * 0.35));
  return head + "\n…[" + (s.length - head.length - tail.length) + " chars elided — head+tail kept]…\n" + tail;
}

// Reliable code search (ripgrep, falling back to grep) — argv array, no shell injection.
function searchCode(query) {
  if (!query) return Promise.resolve("ERROR: query required.");
  const opt = { cwd: wsRoot(), env: execEnv(), maxBuffer: 5 * 1024 * 1024, timeout: 30000 };
  return new Promise((resolve) => {
    cp.execFile("rg", ["-n", "--no-heading", "-S", "--max-count", "50", "--", query, "."], opt, (e, so, se) => {
      if (!(e && e.code === "ENOENT")) {
        // rg is installed and ran: matches, clean "no matches" (exit 1), or a real error.
        if (so && so.trim()) return resolve(clip(so, 8000));
        if (e && e.code !== 1) return resolve("search error: " + String(se || e.message || "").slice(0, 300));
        return resolve("No matches for: " + query);
      }
      // rg not installed → fall back to grep
      cp.execFile("grep", ["-rnI", "-e", query, "."], opt, (e2, so2, se2) => {
        if (so2 && so2.trim()) return resolve(clip(so2, 8000));
        if (e2 && e2.code !== 1) return resolve("search error: " + String(se2 || e2.message || "").slice(0, 300));
        resolve("No matches for: " + query);
      });
    });
  });
}

// Current errors/warnings from VS Code's diagnostics (Problems panel).
function getProblems() {
  try {
    const out = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity <= 1) {
          out.push(vscode.workspace.asRelativePath(uri) + ":" + (d.range.start.line + 1) + " [" + (d.severity === 0 ? "error" : "warning") + "] " + String(d.message || "").split("\n")[0]);
          if (out.length >= 100) break;
        }
      }
      if (out.length >= 100) break;
    }
    return out.length ? clip(out.slice(0, 100).join("\n"), 8000) : "No errors or warnings in the Problems panel.";
  } catch (e) {
    return "ERROR: " + (e.message || e);
  }
}

// ---------- skills ----------
let SKILLS = [];
function loadSkills(extPath) {
  SKILLS = [];
  const dir = path.join(extPath, "skills");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch (_) {}
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const m = raw.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
      let name = f.replace(/\.md$/, ""), description = "", body = raw.trim();
      if (m) {
        body = m[2].trim();
        const nm = m[1].match(/name:\s*(.+)/);
        const dm = m[1].match(/description:\s*(.+)/);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }
      SKILLS.push({ name, description, body });
    } catch (_) {} // a single bad skill file must never break activation
  }
}

// Auto-skill-injection: skills relevant to the user's message get loaded into the system prompt
// for the rest of the session — WITHOUT the model needing to call load_skill.
const activeSkills = new Set();
const SKILL_STOP = new Set("the and for use using via your you this that with run get set name code files file text data only not are can may all any into your need want help make build fix find read write".split(" "));
function relevantSkills(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const scored = [];
  for (const s of SKILLS) {
    const kw = (s.name.replace(/[-_]/g, " ") + " " + s.description).toLowerCase().match(/[a-z][a-z0-9.+/]{2,}/g) || [];
    const seen = new Set();
    let score = 0;
    for (const k of kw) {
      if (seen.has(k) || SKILL_STOP.has(k)) continue;
      seen.add(k);
      if (t.includes(" " + k + " ") || t.includes(" " + k + "s ") || t.includes("/" + k)) score++;
    }
    if (score >= 2) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((x) => x.s);
}

// ---------- system prompt (lean; capabilities live in skills) ----------
function SYSTEM() {
  const skillList = SKILLS.length ? SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "(none)";
  const act = SKILLS.filter((s) => activeSkills.has(s.name));
  const activeBlock = act.length ? "\n## Auto-loaded skills (relevant to this work — FOLLOW these now)\n" + act.map((s) => "### " + s.name + "\n" + s.body).join("\n\n") : "";
  return [
    "You are LocalSRE, an autonomous coding agent inside the user's VS Code on macOS (M3 Pro).",
    "You build, fix, and run real software by USING TOOLS — never by guessing.",
    "",
    "## PERSISTENCE — within the CURRENT task only",
    "While working on the task the user gave you, you hunt: on a failure, read the error, form a new hypothesis, and try a different concrete approach instead of bailing mid-task. Do things yourself with tools rather than asking the user to run them.",
    "STOP-AND-WAIT (important): the moment the task the user asked for is COMPLETE — or you genuinely need a decision only they can make — STOP and wait for their next instruction. Do NOT invent extra work, start new tasks, or keep going on your own. One request → finish it → stop and report. When in doubt about scope, ask the user rather than charging ahead.",
    "",
    "## How you work (like a senior engineer)",
    "- For any MULTI-STEP task, FIRST call update_plan with a short checklist, then work through it — keep exactly one item in_progress, mark it completed, move to the next. Keep the plan current. Skip the plan for trivial one-step asks.",
    "- Inspect before you change (read_file / list_dir). After changes, VERIFY by running the test/build/command; if it fails, fix and re-run until it passes.",
    "- Narrate briefly what you're doing; keep prose short. Match the existing code's style.",
    "",
    "## Memory — never forget, never re-ask",
    "You have PERSISTENT repo-local memory (.localsre/memory.md), shown below when present. It survives across sessions and days.",
    "The 'Saved memory' section below is ALREADY in your context — read it and ANSWER DIRECTLY from it. NEVER say 'I'll check the memory' or 'let me look it up' and never call a tool to retrieve it; the facts are right here — just use them.",
    "- When you learn something DURABLE — how to reach a cluster/service (proxy, kube-context, credentials location), a decision, a setup procedure, or anything the user tells you to remember — call the remember tool to save it immediately.",
    "- BEFORE asking the user a question, check your memory and the conversation above. NEVER ask for something you were already told or already worked out. Do not repeat questions or redo work across sessions.",
    "",
    "## Skills — load on demand",
    "Skills are playbooks for specific jobs. Relevant ones are AUTO-LOADED below; otherwise call load_skill(name) to get the steps. Don't guess these workflows.",
    skillList,
    activeBlock,
    "",
    "## Tools",
    "- read_file / list_dir — read code. write_file (NEW files ONLY) / edit_file (targeted exact old→new replace — PREFER for existing files; never rewrite a whole file).",
    "- After ANY edit, VERIFY: call get_problems and run the relevant test/build; fix errors, then finish.",
    "- consult_expert — ask Claude (cloud) a hard reasoning/review question when stuck or to review your plan/diff (needs a Claude key).",
    "- search_code — find where things are defined/used across the repo (prefer this over guessing paths or hand-writing grep).",
    "- get_problems — read VS Code's current errors/warnings; check before AND after edits and fix them.",
    "- read_document — PDF/DOCX/images (OCR).",
    "- run_command — git, gh, kubectl, pip, brew, npm, tests (user approves each).",
    "- start_server — launch a long-running dev server in the BACKGROUND (don't use run_command for servers, it would block).",
    "- open_preview — open a URL in VS Code's built-in browser so the user can see the UI.",
    "- update_plan — show a live checklist for multi-step work.",
    "",
    "The user's ACTIVE FILE, selection, and open tabs are included at the top of each request. When they say 'this', 'here', 'this file/function', they mean that — act on it (read the active file for full contents if needed).",
    "",
    "## Building UIs / apps end-to-end",
    "Scaffold → install deps → write REAL code → start_server → open_preview → check build/console output → fix errors → iterate.",
    "You are text-only (no vision): you cannot see pixels. Verify via build output and console errors; rely on the user for visual feedback, then make the requested changes (hot-reload picks them up).",
    "",
    "Be concise in prose; let tools do the work. Finish with a short summary + how to run it.",
    "Workspace root: " + wsRoot(),
    projectMemory(),
  ].filter(Boolean).join("\n");
}

// Durable per-repo memory: first of these files found is injected into every session.
function readHead(p, n) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.slice(0, got).toString("utf8");
  } finally { fs.closeSync(fd); }
}
// Read the LAST n bytes — for memory.md, the most RECENT facts (appended at the end) matter most.
function readTail(p, n) {
  const fd = fs.openSync(p, "r");
  try {
    const sz = fs.fstatSync(fd).size;
    const start = Math.max(0, sz - n);
    const len = sz - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return (start > 0 ? "…\n" : "") + buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}
function projectMemory() {
  const parts = [];
  // auto-saved repo-local memory (written by the remember tool) — always loaded
  try {
    const p = path.join(wsRoot(), ".localsre", "memory.md");
    if (fs.existsSync(p)) parts.push("## Saved memory (.localsre/memory.md)\n" + readTail(p, 8000));
  } catch (_) {}
  // user-authored project memory (first one found)
  for (const f of ["AGENTS.md", "CLAUDE.md", ".qwen/memory.md"]) {
    try {
      const p = path.join(wsRoot(), f);
      if (fs.existsSync(p)) { parts.push("## Project memory (" + f + ")\n" + readHead(p, 6000)); break; }
    } catch (_) {}
  }
  return parts.length ? "\n" + parts.join("\n\n") : "";
}

// DeepSeek-R1 emits chain-of-thought in <think>…</think>. Strip it for display + context.
function stripThink(t) {
  return (t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}
// ---------- tool schemas ----------
const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file. Returns contents (truncated if large).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file (use ONLY for brand-new files). Parent dirs are created.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Make a TARGETED edit to an existing file: replace an exact, unique snippet with new text. PREFER this over write_file for existing files — never rewrite a whole file. Fails if old_string is missing or appears more than once (add surrounding context to make it unique).", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "list_dir", description: "List directory entries (dirs end with /).", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the workspace and return stdout+stderr. User approves it. Do NOT use for long-running servers — use start_server.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_document", description: "Extract text from a PDF/DOCX/DOC/RTF/ODT/HTML document, OR OCR the text from a screenshot/image (.png/.jpg/etc). Use instead of read_file for non-text files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "start_server", description: "Launch a long-running process (dev server) in the background; returns its initial output. User approves it.", parameters: { type: "object", properties: { command: { type: "string" }, name: { type: "string", description: "Friendly label, e.g. 'vite' or 'uvicorn'." } }, required: ["command"] } } },
  { type: "function", function: { name: "open_preview", description: "Open a URL in VS Code's built-in Simple Browser so the user can see the running UI.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "load_skill", description: "Load the full instructions for a named skill before doing that kind of task.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "update_plan", description: "Show/update a step-by-step plan as a live checklist. Call FIRST on any multi-step task to outline steps, then call again to mark progress. Keep exactly one item in_progress.", parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } } },
  { type: "function", function: { name: "search_code", description: "Search the codebase for a string/regex and return matching file:line results. Use this to find where things are defined/used instead of guessing.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_problems", description: "Return the current errors and warnings from VS Code's Problems panel (diagnostics) across the workspace. Use before/after edits to see and fix compile/lint errors.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "remember", description: "Save a DURABLE fact to the repo's persistent memory (.localsre/memory.md) so it's available in EVERY future session, forever. Use for environment specifics (how to reach a cluster/service, proxies, kube-contexts, credential locations), decisions made, setup procedures, and anything the user tells you to remember. CHECK memory before asking the user something you may already know.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } } },
  { type: "function", function: { name: "consult_expert", description: "Delegate a HARD reasoning/review question to a stronger cloud model (Claude) and get its answer. Use when stuck, for tricky design decisions, or to review your own plan/diff. Requires a Claude API key.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } } },
];

// ---------- tool execution ----------
function sh(command) {
  return new Promise((resolve) => {
    cp.exec(command, { cwd: wsRoot(), env: execEnv(), timeout: cmdTimeoutMs(), maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
      if (err && !out.trim()) out = "[exit " + (err.code ?? "?") + "] " + (err.message || "");
      resolve(out.trim().slice(0, 20000) || "(no output)");
    });
  });
}

const servers = [];
function killServer(entry) {
  if (!entry.child.pid) { try { entry.child.kill(); } catch (_) {} return; }
  try { process.kill(-entry.child.pid); } // kill the whole process group (detached leader)
  catch (_) { try { entry.child.kill(); } catch (__) {} }
}
function startServer(command, label) {
  return new Promise((resolve) => {
    const child = cp.spawn(command, { cwd: wsRoot(), env: execEnv(), shell: true, detached: true });
    const entry = { child, label: label || command, pid: child.pid };
    servers.push(entry);
    child.on("exit", () => { const i = servers.indexOf(entry); if (i >= 0) servers.splice(i, 1); });
    let buf = "", capped = false;
    const onData = (d) => { if (!capped) { buf += d.toString(); if (buf.length > 8000) capped = true; } };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { buf += "\n[spawn error] " + e.message; });
    setTimeout(() => {
      // stop accumulating output → avoids unbounded memory growth from a chatty server
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onData);
      child.stdout.resume(); child.stderr.resume();
      resolve("[" + (label || "server") + " started, pid " + child.pid + "]\n" + (buf.slice(-3000) || "(no output yet)"));
    }, 5000);
  });
}

async function readDocument(p) {
  if (!fs.existsSync(p)) return "ERROR: file not found: " + p;
  const ext = path.extname(p).toLowerCase();
  // execFile with an argv array — the path is NEVER parsed by a shell, so no command injection.
  const runFile = (file, argv) =>
    new Promise((res) =>
      cp.execFile(file, argv, { env: execEnv(), maxBuffer: 50 * 1024 * 1024, timeout: 180000 }, (e, so, se) =>
        res({ so: so || "", se: se || "", e })
      )
    );
  if ([".docx", ".doc", ".rtf", ".odt", ".html", ".htm", ".webarchive"].includes(ext)) {
    const r = await runFile("textutil", ["-convert", "txt", "-stdout", p]);
    return r.so.trim() ? clip(r.so) : "ERROR(textutil): " + (r.se || "no text");
  }
  if (ext === ".pdf") {
    const r = await runFile("pdftotext", ["-layout", p, "-"]);
    if (r.so && r.so.trim()) return clip(r.so);
    // fallback: pypdf via python; path is argv[1], not shell-interpolated.
    const py =
      "import sys\ntry:\n from pypdf import PdfReader\nexcept Exception:\n import subprocess; subprocess.run([sys.executable,'-m','pip','install','-q','pypdf']); from pypdf import PdfReader\n" +
      "r=PdfReader(sys.argv[1]); print('\\n'.join((pg.extract_text() or '') for pg in r.pages))";
    const r2 = await runFile("python3", ["-c", py, p]);
    return r2.so && r2.so.trim() ? clip(r2.so) : "ERROR: PDF extraction failed. Try `brew install poppler`. " + (r2.se || "").slice(0, 200);
  }
  // Screenshots / images → OCR (text-only models can't see layout, but can read the words).
  if ([".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".gif", ".webp"].includes(ext)) {
    const r = await runFile("tesseract", [p, "-"]);
    if (r.so && r.so.trim()) return "[OCR text extracted from image — visual layout NOT available]\n\n" + clip(r.so);
    return "ERROR: OCR needs tesseract. Install it: `brew install tesseract`, then retry. (Reads TEXT in the image only; the model cannot see the actual picture.)";
  }
  try {
    if (fs.statSync(p).size > 5 * 1024 * 1024) return "ERROR: file too large to read inline; use run_command with head/grep.";
    return clip(fs.readFileSync(p, "utf8"));
  } catch (_) { return "ERROR: unsupported type " + ext; }
}

const pendingApprovals = {};
let approvalSeq = 0;
let postToWebview = null; // set when the chat view resolves
async function approveCommand(command, what) {
  if (cfg().autoApprove) return true;
  if (!postToWebview) {
    // no chat view available → fall back to a modal
    const pick = await vscode.window.showWarningMessage("LocalSRE wants to " + (what || "run a command") + ":", { modal: true, detail: command }, "Approve", "Deny");
    return pick === "Approve";
  }
  // inline Approve/Deny card in the chat panel
  return new Promise((resolve) => {
    const id = "appr" + ++approvalSeq;
    const to = setTimeout(() => { if (pendingApprovals[id]) { delete pendingApprovals[id]; resolve(false); } }, 300000);
    pendingApprovals[id] = (v) => { clearTimeout(to); delete pendingApprovals[id]; resolve(v); };
    postToWebview({ type: "approve", id, command, what: what || "run a command" });
  });
}

async function execTool(name, args) {
  try {
    if (name === "read_file") {
      const fp = resolvePath(args.path);
      const st = fs.statSync(fp);
      if (st.size > 5 * 1024 * 1024)
        return "ERROR: file too large (" + Math.round(st.size / 1e6) + " MB). Use run_command with grep/sed/head to inspect it.";
      return clip(fs.readFileSync(fp, "utf8"), 20000);
    }
    if (name === "write_file") {
      const p = resolvePath(args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content ?? "");
      vscode.workspace.openTextDocument(p).then((d) => vscode.window.showTextDocument(d, { preview: false }), () => {});
      return `wrote ${args.path} (${(args.content || "").length} bytes)`;
    }
    if (name === "edit_file") {
      const fp = resolvePath(args.path);
      let src;
      try { src = fs.readFileSync(fp, "utf8"); } catch (_) { return "ERROR: cannot read " + args.path + " (does it exist?)."; }
      const oldS = String(args.old_string ?? ""), newS = String(args.new_string ?? "");
      if (!oldS) return "ERROR: old_string is empty.";
      const count = src.split(oldS).length - 1;
      if (count === 0) return "ERROR: old_string not found in " + args.path + " — read the file and copy an EXACT snippet (including whitespace).";
      if (count > 1) return "ERROR: old_string appears " + count + " times — add more surrounding context to make it unique.";
      fs.writeFileSync(fp, src.replace(oldS, newS));
      vscode.workspace.openTextDocument(fp).then((d) => vscode.window.showTextDocument(d, { preview: false }), () => {});
      return "Edited " + args.path + " (−" + oldS.split("\n").length + " / +" + newS.split("\n").length + " lines).";
    }
    if (name === "list_dir") {
      return fs.readdirSync(resolvePath(args.path || "."), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
    }
    if (name === "run_command") {
      if (!(await approveCommand(args.command))) return "DENIED by user.";
      return await sh(args.command);
    }
    if (name === "start_server") {
      if (!(await approveCommand(args.command, "start a background server"))) return "DENIED by user.";
      return await startServer(args.command, args.name);
    }
    if (name === "open_preview") {
      await vscode.commands.executeCommand("simpleBrowser.show", args.url);
      return "opened preview: " + args.url;
    }
    if (name === "read_document") return await readDocument(resolvePath(args.path));
    if (name === "load_skill") {
      const s = SKILLS.find((x) => x.name === args.name);
      return s ? s.body : "No such skill. Available: " + SKILLS.map((x) => x.name).join(", ");
    }
    if (name === "update_plan") {
      if (postToWebview) postToWebview({ type: "plan", todos: Array.isArray(args.todos) ? args.todos : [] });
      return "Plan updated.";
    }
    if (name === "search_code") return await searchCode(args.query || "");
    if (name === "get_problems") return getProblems();
    if (name === "remember") {
      const note = String(args.note || "").replace(/\s*\n\s*/g, " ").trim();
      if (!note) return "ERROR: empty note.";
      const dir = path.join(wsRoot(), ".localsre");
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "memory.md");
      const fresh = !fs.existsSync(f);
      let existing = "";
      try { existing = fs.readFileSync(f, "utf8"); } catch (_) {}
      const norm = (s) => s.replace(/^[-*]\s*/, "").trim();
      if (existing.split("\n").some((l) => norm(l) === note)) return "Already in memory.";
      fs.appendFileSync(f, (fresh ? "# LocalSRE memory (persists every session)\n" : "") + "- " + note + "\n");
      try {
        if (fs.statSync(f).size > 16000) { // keep it bounded → fast reads, recent facts
          const lines = fs.readFileSync(f, "utf8").split("\n");
          const header = lines[0].startsWith("#") ? lines.shift() : "# LocalSRE memory (persists every session)";
          fs.writeFileSync(f, header + "\n" + lines.filter(Boolean).slice(-200).join("\n") + "\n");
        }
      } catch (_) {}
      return "Saved to repo memory (.localsre/memory.md).";
    }
    if (name === "consult_expert") {
      const key = await getAnthropicKey();
      if (!key) return "No Claude key available — set ANTHROPIC_API_KEY or run 'LocalSRE: Set Claude API Key'. (Without it, rely on your own reasoning.)";
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: String(args.question || "") }] }),
        });
        if (!res.ok) return "consult error: " + (await res.text()).slice(0, 200);
        const data = await res.json();
        return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "(no answer)";
      } catch (e) { return "consult error: " + (e.message || e); }
    }
    return "ERROR: unknown tool " + name;
  } catch (e) {
    return "ERROR: " + (e.message || String(e));
  }
}

// ---------- model selection (local endpoint + GitHub Copilot) ----------
const active = { provider: null, model: null }; // null = fall back to settings
function curProvider() { return active.provider || cfg().provider; }
function curModel() { return active.model || cfg().model; }
// Zero-config local model: if the user hasn't picked one, auto-detect from the endpoint (Ollama/llama.cpp).
let autoLocalModel = null;
async function localModelName() {
  if (active.model) return active.model; // user explicitly chose a model
  if (autoLocalModel) return autoLocalModel;
  const c = cfg();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(c.endpoint + "/models", { signal: ctrl.signal, headers: c.apiKey ? { Authorization: "Bearer " + c.apiKey } : {} });
    const data = await res.json();
    const ids = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    if (ids.length) {
      autoLocalModel = ids.find((x) => x === c.model) || ids.find((x) => /qwen.*coder/i.test(x)) || ids.find((x) => /qwen/i.test(x)) || ids[0];
      return autoLocalModel;
    }
  } catch (_) {} finally { clearTimeout(to); }
  return c.model;
}

async function listModels() {
  const items = [];
  // local models from the OpenAI-compatible endpoint (Ollama lists all imported models; llama.cpp lists the loaded one)
  try {
    const c = cfg();
    const res = await fetch(c.endpoint + "/models", { headers: c.apiKey ? { Authorization: "Bearer " + c.apiKey } : {} });
    const data = await res.json();
    for (const m of data.data || data.models || []) {
      const id = m.id || m.name;
      if (id) items.push({ label: "$(server) " + id, description: "local", _p: "local", _m: id });
    }
  } catch (_) {}
  // GitHub Copilot subscription models via the VS Code Language Model API
  try {
    const cps = (await vscode.lm.selectChatModels({ vendor: "copilot" })) || [];
    for (const m of cps) items.push({ label: "$(copilot) " + (m.name || m.family), description: "GitHub Copilot", _p: "copilot", _m: m.family || m.id });
  } catch (_) {}
  // Claude via Anthropic key — only shown if a key is in the keychain/settings
  const akey = await getAnthropicKey();
  if (akey) for (const m of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) items.push({ label: "$(sparkle) " + m, description: "Claude (Anthropic API)", _p: "anthropic", _m: m });
  return items;
}
async function selectModel() {
  const items = await listModels();
  if (!items.length) { vscode.window.showWarningMessage("No models found. Start your local server (llama.cpp/Ollama) or sign in to GitHub Copilot."); return null; }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Model — current: " + curProvider() + ":" + curModel() });
  if (pick) { active.provider = pick._p; active.model = pick._m; vscode.window.showInformationMessage("LocalSRE → " + pick._p + ": " + pick._m); }
  return pick;
}

// ---------- secrets (OS keychain via VS Code SecretStorage) ----------
let SECRETS = null;
async function getSecret(key, fallback) {
  try { const v = SECRETS && (await SECRETS.get(key)); if (v) return v; } catch (_) {}
  return fallback || "";
}
// Claude key resolution: keychain → settings → ANTHROPIC_API_KEY env (same var Claude Code uses).
async function getAnthropicKey() {
  return (await getSecret("localsre.anthropicApiKey", cfg().anthropicApiKey)) || process.env.ANTHROPIC_API_KEY || "";
}

// ---------- model call (dispatches to local HTTP / Copilot / Claude) ----------
async function callModel(messages, onDelta) {
  const p = curProvider();
  if (p === "copilot") return callModelLM(messages, onDelta);
  if (p === "anthropic") return callModelAnthropic(messages);
  return callModelHTTP(messages, onDelta);
}

let activeAbort = null;   // the in-flight model call's AbortController (for the Stop button)
let stopRequested = false; // set by Stop; checked in the agent loop
// STEERING: messages typed while the agent is mid-run get injected into the LIVE run at the
// next step (and the in-flight model call is aborted so it reacts in seconds) — instead of
// queueing behind everything as a separate turn. This is how Claude Code feels responsive.
let steerBuffer = [];

async function callModelHTTP(messages, onDelta) {
  const c = cfg();
  if (!c.endpoint) throw new Error("No endpoint configured (localsre.endpoint).");
  const headers = { "Content-Type": "application/json" };
  if (c.apiKey) headers["Authorization"] = "Bearer " + c.apiKey;
  const ctrl = new AbortController();
  activeAbort = ctrl;
  const to = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(c.endpoint + "/chat/completions", {
      method: "POST", headers, signal: ctrl.signal,
      body: JSON.stringify({ model: await localModelName(), messages, tools: TOOLS, tool_choice: "auto", temperature: c.temperature, stream: !!onDelta }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    // Stream when asked (real servers); fall back to JSON when there's no readable body (tests/non-stream).
    if (onDelta && res.body && typeof res.body.getReader === "function") return await parseSSE(res.body, onDelta);
    const data = await res.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error("Malformed response (no message).");
    return data.choices[0].message;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(stopRequested ? "stopped" : "Model timed out (180s).");
    throw e;
  } finally { clearTimeout(to); activeAbort = null; }
}

// Parse an OpenAI-style SSE stream: emit text deltas live, assemble tool_calls by index.
async function parseSSE(body, onDelta) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "";
  const toolMap = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      let j;
      try { j = JSON.parse(d); } catch (_) { continue; }
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onDelta(delta.content); }
      for (const tcd of delta.tool_calls || []) {
        const idx = tcd.index || 0;
        const e = toolMap[idx] || (toolMap[idx] = { id: tcd.id || "", function: { name: "", arguments: "" } });
        if (tcd.id) e.id = tcd.id;
        if (tcd.function && tcd.function.name) e.function.name += tcd.function.name;
        if (tcd.function && tcd.function.arguments) e.function.arguments += tcd.function.arguments;
      }
    }
  }
  const tcs = Object.keys(toolMap).sort((a, b) => a - b).map((k) => toolMap[k]).filter((t) => t.function.name);
  return { content, tool_calls: tcs.length ? tcs : undefined };
}

// Use the user's GitHub Copilot models through VS Code's Language Model API.
function toLMMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "user") {
      out.push(vscode.LanguageModelChatMessage.User(typeof m.content === "string" ? m.content : ""));
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push(new vscode.LanguageModelTextPart(m.content));
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input));
      }
      if (parts.length) out.push(vscode.LanguageModelChatMessage.Assistant(parts));
    } else if (m.role === "tool") {
      out.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(m.tool_call_id, [new vscode.LanguageModelTextPart(String(m.content))])]));
    }
  }
  return out;
}
async function callModelLM(messages, onDelta) {
  const fam = curModel();
  let models = (await vscode.lm.selectChatModels({ vendor: "copilot", family: fam })) || [];
  if (!models.length) models = (await vscode.lm.selectChatModels({ vendor: "copilot" })) || [];
  if (!models.length) throw new Error("No Copilot model available. Sign in to GitHub Copilot in VS Code.");
  const lmTools = TOOLS.map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
  const cts = new vscode.CancellationTokenSource();
  const to = setTimeout(() => cts.cancel(), 180000); // Copilot path must not hang forever
  try {
    const resp = await models[0].sendRequest(toLMMessages(messages), { tools: lmTools }, cts.token);
    let content = "";
    const toolCalls = [];
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) { content += part.value; if (onDelta) onDelta(part.value); }
      else if (part instanceof vscode.LanguageModelToolCallPart)
        toolCalls.push({ id: part.callId, function: { name: part.name, arguments: JSON.stringify(part.input || {}) } });
    }
    return { content, tool_calls: toolCalls.length ? toolCalls : undefined };
  } catch (e) {
    if (cts.token.isCancellationRequested) throw new Error("Copilot timed out (180s).");
    throw e;
  } finally { clearTimeout(to); cts.dispose(); }
}

// Bound the live context sent to the model — keeps prefill FLAT across a long session
// (fixes the slow-down + context-overflow + token-inflation the validation found).
const HISTORY_CAP = 40;
let toolIdSeq = 0; // process-global so tool_call_ids never collide across turns
function trimInPlace(messages) {
  if (messages.length <= HISTORY_CAP + 1) return; // +1 for system
  let start = messages.length - HISTORY_CAP;
  // advance to a SAFE cut boundary: a user message, or an assistant WITHOUT tool_calls.
  // Never start the kept window on a 'tool' or a dangling assistant→tool_calls (Ollama 400),
  // and never run off the end (that would wipe the whole conversation).
  while (start < messages.length) {
    const m = messages[start];
    if (m.role === "user") break;
    if (m.role === "assistant" && !(m.tool_calls && m.tool_calls.length)) break;
    start++;
  }
  if (start < messages.length && start > 2) messages.splice(2, start - 2); // keep system + first turn + window
}

// ---------- agent loop ----------
async function runAgent(userText, messages, post) {
  messages.push({ role: "user", content: userText });
  const c = cfg();
  const originalTask = String(userText).replace(/\[Editor context[\s\S]*?\[User request\]\n/, "").slice(0, 600); // anchor
  const callLog = {}; // detect repeated identical tool calls (local models tend to loop)
  let edited = false, verified = false, verifyNudges = 0; // self-verify loop state
  for (let i = 0; i < c.maxIterations; i++) {
    if (stopRequested) { post({ type: "assistant", text: "⏹ stopped." }); return; }
    // steer: fold in anything the user typed mid-run — their new instruction takes priority NOW
    if (steerBuffer.length) {
      for (const s of steerBuffer.splice(0)) {
        messages.push({ role: "user", content: "[STEERING — the user just said this MID-TASK. It takes priority over your current plan. Adjust immediately:]\n" + s });
      }
      post({ type: "status", text: "↪ steering — picked up your new instruction" });
    }
    // (1) Reflection + (2) anchoring: every 6 rounds, re-orient to the goal (local models drift/loop).
    if (i > 0 && i % 6 === 0) {
      messages.push({ role: "user", content: "[CHECKPOINT — not a new task] Re-read the ORIGINAL goal: \"" + originalTask + "\". State briefly what is DONE, what is LEFT, and whether you're still on target. If you're repeating yourself or drifting, switch approach NOW. Then keep going." });
      post({ type: "status", text: "↻ reflection checkpoint" });
    }
    trimInPlace(messages); // bound prefill every iteration
    post({ type: "status", text: "thinking…" });
    let msg;
    let streamed = false;
    const onDelta = (t) => { streamed = true; post({ type: "assistantDelta", text: t }); };
    try { msg = await callModel(messages, onDelta); }
    catch (e) {
      if (streamed) post({ type: "assistantEnd" });
      const em = String(e.message || e);
      if (em === "stopped" || stopRequested) { post({ type: "assistant", text: "⏹ stopped." }); return; }
      if (steerBuffer.length) continue; // call aborted because the user steered — loop picks up their message NOW
      post({ type: "error", text: em }); return;
    }
    if (streamed) post({ type: "assistantEnd" }); // finalize the streamed bubble

    const content = stripThink(msg.content || "");
    // Keep only well-formed tool calls; give each a stable unique id reused in the tool result.
    const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((tc) => tc && tc.function && tc.function.name);
    toolCalls.forEach((tc) => { if (!tc.id) tc.id = "call_" + ++toolIdSeq; });
    // OpenAI protocol wants content:null (not "") when tool_calls are present.
    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined });

    if (toolCalls.length) {
      if (content && !streamed) post({ type: "assistant", text: content });
      for (const tc of toolCalls) {
        if (stopRequested) { post({ type: "assistant", text: "⏹ stopped." }); return; }
        const tname = tc.function.name;
        if (tname === "write_file" || tname === "edit_file") edited = true;
        if (tname === "get_problems" || tname === "run_command") verified = true;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        post({ type: "tool", name: tname, args });
        // Loop guard: if the model repeats the EXACT same call, stop re-running it and tell it to change course.
        const sig = tname + "::" + (tc.function.arguments || "");
        callLog[sig] = (callLog[sig] || 0) + 1;
        let result;
        if (callLog[sig] >= 3) {
          // (3) Stuck-recovery: anchor back to the goal and force a fundamentally different approach.
          result = "LOOP DETECTED: you already made this exact call 3 times — the result won't change. STOP. Step back, re-read the original goal (\"" + originalTask + "\"), and take a FUNDAMENTALLY different approach (different tool, different command, or ask the user one specific question). Do NOT repeat this call.";
          callLog[sig] = 0; // reset — a later genuine call (e.g. re-read after an edit) must still run
        } else {
          result = await execTool(tname, args);
        }
        post({ type: "toolResult", name: tname, result: String(result).slice(0, 4000) });
        // (4) Distill (head+tail) what goes back into context — keeps prefill lean AND keeps the signal.
        messages.push({ role: "tool", tool_call_id: tc.id, content: distill(result, 6000) });
      }
      continue;
    }

    // Self-verify: if we edited files but never checked them, run one verification pass first.
    if (edited && !verified && verifyNudges < 1) {
      verifyNudges++;
      messages.push({ role: "user", content: "You edited files but didn't verify. Call get_problems and run the relevant test/build; fix any errors, then give your final summary." });
      continue;
    }
    // No tool calls → done. (Already shown live if streamed.)
    if (!streamed) post({ type: "assistant", text: content || "(no content)" });
    return;
  }
  post({ type: "assistant", text: "⚠️ Reached the step limit (" + c.maxIterations + " tool rounds). Paused here — reply 'continue' to keep going, or raise localsre.maxIterations in Settings for longer tasks." });
}

// Optional: Claude directly via an Anthropic API key (stored in the OS keychain, not settings).
async function callModelAnthropic(messages) {
  const key = await getAnthropicKey();
  if (!key) throw new Error("No Claude key. Set ANTHROPIC_API_KEY in your shell (same as Claude Code), run 'LocalSRE: Set Claude API Key', or pick Claude under the Copilot provider.");
  let model = curModel();
  if (!/claude/i.test(model)) model = "claude-sonnet-4-6";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
  const conv = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") conv.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) conv.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) }] });
    }
  }
  const tools = TOOLS.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system: system || undefined, messages: conv, tools }),
    });
    if (!res.ok) throw new Error("Anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    let content = "";
    const toolCalls = [];
    for (const b of data.content || []) {
      if (b.type === "text") content += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    }
    return { content, tool_calls: toolCalls.length ? toolCalls : undefined };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Claude timed out (180s).");
    throw e;
  } finally { clearTimeout(to); }
}

// ---------- webview ----------
class ChatProvider {
  constructor(context) {
    this.context = context;
    this.messages = this._load(); // per-workspace history (survives reloads + folder switches)
    this.busy = false; // a turn is in flight
    this.queue = []; // you can keep typing/sending — asks queue and run in order (like Claude Code)
  }
  async _drain(post) {
    if (this.busy) return;
    this.busy = true;
    stopRequested = false; // fresh run
    try {
      while ((this.queue.length || steerBuffer.length) && !stopRequested) {
        // a steer that arrived in the run's final moments becomes the next turn (never dropped)
        const text = this.queue.length ? this.queue.shift() : steerBuffer.shift();
        try { await runAgent(text, this.messages, post); this._save(); }
        catch (e) { post({ type: "error", text: "internal: " + (e && e.message ? e.message : String(e)) }); }
      }
    } finally { this.busy = false; post({ type: "done" }); }
  }
  _load() {
    const saved = this.context.workspaceState.get("localsre.history");
    if (Array.isArray(saved) && saved.length) { saved[0] = { role: "system", content: SYSTEM() }; return saved; }
    return [{ role: "system", content: SYSTEM() }];
  }
  _save() {
    // system + last 60 turns; drop any leading tool / dangling assistant→tool_calls so the
    // restored history never starts mid-pair (which Ollama/OpenAI reject with a 400).
    let tail = this.messages.slice(1).slice(-60);
    while (tail.length && (tail[0].role === "tool" || (tail[0].role === "assistant" && tail[0].tool_calls))) tail.shift();
    this.context.workspaceState.update("localsre.history", [{ role: "system", content: SYSTEM() }, ...tail]);
  }
  reset() {
    activeSkills.clear();
    this.messages = [{ role: "system", content: SYSTEM() }];
    this._save();
    if (this.view) this.view.webview.postMessage({ type: "cleared" });
  }
  _replay() {
    if (!this.view) return;
    const items = this.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
      .map((m) => ({ role: m.role, text: m.content }));
    if (items.length) this.view.webview.postMessage({ type: "restore", items });
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml();
    const post = (m) => { try { view.webview.postMessage(m); } catch (_) {} };
    postToWebview = post; // enable inline approvals
    view.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === "ready") this._replay(); // webview is now listening → safe to restore history
        else if (m.type === "ask") {
          const newly = relevantSkills(m.text).filter((s) => !activeSkills.has(s.name));
          if (newly.length) {
            newly.forEach((s) => activeSkills.add(s.name));
            this.messages[0] = { role: "system", content: SYSTEM() }; // refresh system prompt with the auto-loaded skills
            post({ type: "status", text: "auto-loaded skill: " + newly.map((s) => s.name).join(", ") });
          }
          if (this.busy) {
            // mid-run → STEER the live run (abort the in-flight call so it reacts in seconds)
            steerBuffer.push(withEditorContext(m.text));
            if (activeAbort) { try { activeAbort.abort(); } catch (_) {} }
            post({ type: "status", text: "↪ got it — steering the current run" });
          } else {
            this.queue.push(withEditorContext(m.text));
            this._drain(post);
          }
        }
        else if (m.type === "reset") this.reset();
        else if (m.type === "switchModel") await vscode.commands.executeCommand("localsre.selectModel");
        else if (m.type === "approveResult") { const r = pendingApprovals[m.id]; if (r) r(!!m.approved); }
        else if (m.type === "stop") { stopRequested = true; this.queue.length = 0; steerBuffer.length = 0; if (activeAbort) { try { activeAbort.abort(); } catch (_) {} } post({ type: "status", text: "stopping…" }); }
      } catch (e) {
        // Never let an error escape into the extension host.
        post({ type: "error", text: "internal: " + (e && e.message ? e.message : String(e)) });
        post({ type: "done" });
      }
    });
    // On view disposal: clear stale refs (restores the modal fallback) and settle any pending approvals as denied.
    view.onDidDispose(() => {
      if (this.view === view) { this.view = null; postToWebview = null; }
      for (const id of Object.keys(pendingApprovals)) pendingApprovals[id](false);
    });
  }
}

function getHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:var(--vscode-font-family);font-size:14px;line-height:1.6;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:0;display:flex;flex-direction:column;height:100vh;}
  #log{flex:1;overflow-y:auto;padding:12px;}
  .msg{margin:10px 0;padding:10px 12px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;color:var(--vscode-editor-foreground);}
  .user{background:var(--vscode-input-background);border:1px solid var(--vscode-focusBorder,#0a84ff);}
  .assistant{background:var(--vscode-textBlockQuote-background,rgba(128,128,128,0.14));border-left:3px solid var(--vscode-focusBorder,#0a84ff);}
  .tool{font-family:var(--vscode-editor-font-family);font-size:12.5px;background:var(--vscode-textCodeBlock-background);border-left:3px solid var(--vscode-charts-blue);padding:6px 8px;margin:4px 0;color:var(--vscode-editor-foreground);}
  .toolres{font-family:var(--vscode-editor-font-family);font-size:12.5px;color:var(--vscode-editor-foreground);opacity:.85;background:var(--vscode-textCodeBlock-background);padding:6px 8px;margin:2px 0 8px;max-height:180px;overflow:auto;border-left:3px solid var(--vscode-charts-green);}
  .err{color:var(--vscode-errorForeground);}
  .status{color:var(--vscode-descriptionForeground);font-style:italic;}
  #bar{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);}
  #inp{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#888);border-radius:6px;padding:8px;font-family:inherit;font-size:14px;}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;padding:7px 10px;cursor:pointer;font-size:13px;}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  .label{font-weight:700;opacity:.6;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;}
  .approve{background:var(--vscode-inputValidation-warningBackground,rgba(255,180,0,.12));border:1px solid var(--vscode-inputValidation-warningBorder,#caa700);}
  .approve .cmd{font-family:var(--vscode-editor-font-family);font-size:12.5px;background:var(--vscode-textCodeBlock-background);padding:6px 8px;border-radius:4px;margin:6px 0 0;white-space:pre-wrap;word-break:break-all;}
  .approw{display:flex;gap:8px;margin-top:8px;}
  .okbtn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600;}
  .adone{opacity:.75;font-size:12.5px;font-weight:600;}
  #plan{display:none;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);}
  .planhd{font-weight:700;opacity:.6;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px;}
  .pstep{font-size:13px;padding:2px 0;color:var(--vscode-editor-foreground);}
  .pstep.pdone{opacity:.5;text-decoration:line-through;}
  .pstep.pcur{font-weight:600;color:var(--vscode-charts-blue);}
</style></head><body>
<div id="plan"></div>
<div id="log"></div>
<div id="bar">
  <textarea id="inp" rows="2" placeholder="Ask LocalSRE to build, fix, run… (Enter to send, Shift+Enter newline)"></textarea>
  <div style="display:flex;flex-direction:column;gap:4px;"><button id="send">Send</button><button id="stop" class="sec">⏹ Stop</button><button id="model" class="sec">Model</button><button id="reset" class="sec">Reset</button></div>
</div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log'); const inp = document.getElementById('inp'); let statusEl=null; let streamEl=null;
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function add(cls,html){const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function clearStatus(){if(statusEl){statusEl.remove();statusEl=null;}}
function send(){const t=inp.value.trim();if(!t)return;add('user','<span class="label">you</span>\\n'+esc(t));inp.value='';vscode.postMessage({type:'ask',text:t});statusEl=add('status','…');}
document.getElementById('send').onclick=send;
document.getElementById('reset').onclick=()=>vscode.postMessage({type:'reset'});
document.getElementById('model').onclick=()=>vscode.postMessage({type:'switchModel'});
document.getElementById('stop').onclick=()=>vscode.postMessage({type:'stop'});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
window.addEventListener('message',ev=>{const m=ev.data;
  if(m.type==='status'){if(statusEl)statusEl.textContent=m.text;}
  else if(m.type==='assistantDelta'){clearStatus();if(!streamEl){streamEl=add('assistant','<span class="label">sre</span>\\n');streamEl._raw='';}streamEl._raw+=m.text;streamEl.innerHTML='<span class="label">sre</span>\\n'+esc(streamEl._raw);log.scrollTop=log.scrollHeight;}
  else if(m.type==='assistantEnd'){streamEl=null;}
  else if(m.type==='assistant'){clearStatus();streamEl=null;add('assistant','<span class="label">sre</span>\\n'+esc(m.text));}
  else if(m.type==='tool'){clearStatus();add('tool','▶ '+esc(m.name)+'('+esc(JSON.stringify(m.args))+')');statusEl=add('status','running…');}
  else if(m.type==='toolResult'){clearStatus();add('toolres',esc(m.result));}
  else if(m.type==='error'){clearStatus();add('assistant err','⚠ '+esc(m.text));}
  else if(m.type==='model'){clearStatus();add('status','model → '+esc(m.name));}
  else if(m.type==='restore'){log.innerHTML='';m.items.forEach(it=>add(it.role==='user'?'user':'assistant','<span class="label">'+(it.role==='user'?'you':'sre')+'</span>\\n'+esc(it.text)));}
  else if(m.type==='plan'){var p=document.getElementById('plan');if(!m.todos||!m.todos.length){p.innerHTML='';p.style.display='none';}else{p.style.display='block';p.innerHTML='<div class="planhd">plan</div>'+m.todos.map(function(t){var i=t.status==='completed'?'✓':(t.status==='in_progress'?'▸':'○');var c=t.status==='completed'?'pdone':(t.status==='in_progress'?'pcur':'');return '<div class="pstep '+c+'">'+i+' '+esc(t.content)+'</div>';}).join('');}}
  else if(m.type==='cleared'){log.innerHTML='';var pl=document.getElementById('plan');pl.innerHTML='';pl.style.display='none';}
  else if(m.type==='approve'){clearStatus();
    const d=document.createElement('div');d.className='msg approve';
    d.innerHTML='<div class="label">approve · '+esc(m.what)+'</div><pre class="cmd">'+esc(m.command)+'</pre>';
    const row=document.createElement('div');row.className='approw';
    const ok=document.createElement('button');ok.textContent='✓ Approve';ok.className='okbtn';
    const no=document.createElement('button');no.textContent='✗ Deny';no.className='sec';
    ok.onclick=()=>{vscode.postMessage({type:'approveResult',id:m.id,approved:true});row.innerHTML='<span class="adone">✓ approved</span>';};
    no.onclick=()=>{vscode.postMessage({type:'approveResult',id:m.id,approved:false});row.innerHTML='<span class="adone">✗ denied</span>';};
    row.appendChild(ok);row.appendChild(no);d.appendChild(row);log.appendChild(d);log.scrollTop=log.scrollHeight;
  }
  else if(m.type==='done'){clearStatus();}
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

// ---------- activation ----------
function activate(context) {
  SECRETS = context.secrets;
  loadSkills(context.extensionPath);
  const provider = new ChatProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localsre.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("localsre.openChat", () => vscode.commands.executeCommand("localsre.chat.focus")),
    vscode.commands.registerCommand("localsre.reset", () => provider.reset()),
    vscode.commands.registerCommand("localsre.selectModel", async () => {
      await selectModel();
      if (provider.view) provider.view.webview.postMessage({ type: "model", name: curProvider() + ":" + curModel() });
    }),
    vscode.commands.registerCommand("localsre.setClaudeKey", async () => {
      const k = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: "Anthropic API key (stored in the OS keychain, not settings)" });
      if (k) { await SECRETS.store("localsre.anthropicApiKey", k.trim()); vscode.window.showInformationMessage("Claude key saved to keychain."); }
    })
  );
}
function deactivate() {
  for (const s of servers.slice()) killServer(s);
}
module.exports = { activate, deactivate };
// Test-only surface (harmless in production; used by test/run.js).
module.exports._test = { execTool, runAgent, callModel, loadSkills, getSkills: () => SKILLS, SYSTEM, relevantSkills };
