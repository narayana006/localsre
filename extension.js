// LocalSRE — lightweight local agentic coding assistant for VS Code.
// Talks to a local OpenAI-compatible server (llama.cpp `llama-server --jinja`)
// and drives a local model (Qwen3-Coder / DeepSeek-Coder-V2-Lite / DeepSeek-R1)
// through a real tool-calling agent loop with a skills system.

const vscode = require("vscode");
const cp = require("child_process");
const os = require("os");
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

// Session working directory — persists across tool calls so the model doesn't snap back to wsRoot.
let sessionCwd = null;
// Files touched this session — injected into system prompt so trim never erases "what was I editing".
const sessionFiles = { read: new Set(), written: new Set() };
// Pinned context facts — survive trims, injected into system prompt. Max 10 entries.
const sessionPins = new Map();
const PIN_CAP = 10;
// Task checkpoint — structured snapshot of problem/findings/changes/remaining, survives trims.
let activeCheckpoint = null;
function getCwd() { return sessionCwd || wsRoot(); }
function setCwd(p) {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) return "ERROR: directory does not exist: " + resolved;
  if (!fs.statSync(resolved).isDirectory()) return "ERROR: not a directory: " + resolved;
  sessionCwd = resolved;
  return "Working directory set to: " + resolved;
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(getCwd(), p || ".");
}
// Confine a path to the workspace OR sessionCwd (and never the secrets file). Returns null if it escapes.
function safePath(p, { allowSecrets = false } = {}) {
  const wsR = path.resolve(wsRoot());
  const cwdR = path.resolve(getCwd());
  const resolved = path.resolve(resolvePath(p));
  const inWs = resolved === wsR || resolved.startsWith(wsR + path.sep);
  const inCwd = resolved === cwdR || resolved.startsWith(cwdR + path.sep);
  if (!inWs && !inCwd) return null; // outside both workspace and sessionCwd
  if (!allowSecrets && resolved.startsWith(path.join(wsR, ".localsre", "secrets"))) return null;
  return resolved;
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
  s = String(s);
  if (s.length <= n) return s;
  // snap to a line boundary so we never cut a number/JSON token mid-stream
  let cut = s.lastIndexOf("\n", n); if (cut < n * 0.5) cut = n;
  return s.slice(0, cut) + "\n[⚠ TRUNCATED — showing first " + cut + " of " + s.length + " chars. This is NOT the whole content; do not assume it ends here — read the rest with run_command (sed/grep/tail).]";
}
// Distill long tool output: keep HEAD + TAIL (errors/results usually live at the end), snapped to line
// boundaries, with an UNMISSABLE marker so the model never treats the elided middle as complete data.
function distill(s, n = 6000) {
  s = String(s);
  if (s.length <= n) return s;
  let hEnd = Math.floor(n * 0.6); hEnd = s.lastIndexOf("\n", hEnd); if (hEnd < n * 0.3) hEnd = Math.floor(n * 0.6);
  let tStart = s.length - Math.floor(n * 0.35); const nl = s.indexOf("\n", tStart); if (nl > -1 && nl < s.length - 50) tStart = nl + 1;
  const head = s.slice(0, hEnd), tail = s.slice(tStart);
  const elidedChars = s.length - head.length - tail.length;
  const elidedLines = (s.slice(hEnd, tStart).match(/\n/g) || []).length;
  return head + "\n\n[⚠ MIDDLE OMITTED — " + elidedLines + " lines (" + elidedChars + " chars) removed. The output below is the TAIL only, not the full result. Do NOT infer totals, counts, or completeness from what you see; re-run with a narrower query/grep if you need the middle.]\n\n" + tail;
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
  const cwdLine = sessionCwd ? `\n## Current working directory\n${sessionCwd}\nAll relative paths, run_command, and file ops resolve from here. Call change_dir to switch.` : "";
  const touched = [...sessionFiles.written].map(f => "✎ " + f).concat([...sessionFiles.read].filter(f => !sessionFiles.written.has(f)).map(f => "👁 " + f));
  const filesLine = touched.length ? "\n## Files touched this session (re-read before editing if context was trimmed)\n" + touched.join("\n") : "";
  const pinsLine = sessionPins.size ? "\n## Pinned context (survives trims — do not re-derive these)\n" + [...sessionPins.entries()].map(([k, v]) => "- " + k + ": " + v).join("\n") : "";
  const cpLine = activeCheckpoint ? "\n## Task checkpoint (resume from here after any trim)\nProblem: " + activeCheckpoint.problem + (activeCheckpoint.findings ? "\nFindings: " + activeCheckpoint.findings : "") + (activeCheckpoint.changes_made ? "\nChanges made: " + activeCheckpoint.changes_made : "") + "\nRemaining: " + activeCheckpoint.remaining : "";
  return [
    "You are LocalSRE, an autonomous SRE and coding agent running inside the user's VS Code on macOS. You fix, build, and run real software using tools.",
    "Use your judgment: reply in text when no tools are needed, use tools when the task actually requires them. Never use run_command just to echo text — write replies directly.",
    "ANTI-FABRICATION: Never invent file paths, line numbers, or function names not visible in context. If a tool result is TRUNCATED/NO DATA, say so — don't infer.",
    "CAPABILITY: You run REAL tools on the user's real machine. Never say 'I am an AI and cannot do X'. Use run_command for actual terminal tasks — installs, scripts, git, kubectl, docker, brew — anything the user asks you to run.",
    "",
    "## How you work",
    "- Read before edit: read_file the target before any edit_file. Never edit from memory.",
    "- After every edit: call get_problems + run the relevant test/build. Fix failures.",
    "- Destructive commands (rm -rf, DROP TABLE, kubectl delete): tell the user what will be deleted first.",
    "- Secrets: env vars only, never hardcoded. Never commit .env to git.",
    "- Multi-step tasks: call update_plan with a checklist first.",
    "- Finish then stop: complete the task, report briefly, stop. Don't invent follow-on work.",
    "",
    "## Memory",
    "Persistent memory (.localsre/memory.md) is shown below — answer from it directly, no tool needed. Save durable facts (cluster access, decisions, setup steps) with remember().",
    "",
    "## Skills",
    "Skills are step-by-step playbooks. Relevant ones auto-load below. Call load_skill(name) for others.",
    skillList,
    activeBlock,
    "",
    "## Tools",
    "- read_file / list_dir / search_code — explore. Never guess paths.",
    "- edit_file — exact old→new replace on existing files (read first). write_file — new files only.",
    "- run_command — any shell command: pip/npm/brew install, git, kubectl, docker, curl, python3, node, terraform, `code --install-extension file.vsix`, etc.",
    "- get_problems — VS Code errors/warnings. Check before AND after edits.",
    "- start_server — background long-running process (use this, not run_command, for servers).",
    "- datadog_query / gcp_logs / k8s_view — read-only SRE connectors.",
    "- mcp_* — MCP server tools (datadog, github, etc.).",
    "- open_preview / update_plan / change_dir / remember / load_skill / read_document — agent utilities.",
    "- show_diff / confirm_scope / state_hypothesis / pin_context / checkpoint_plan — discipline tools (use when doing complex multi-file work).",
    "",
    "Active file/selection/tabs included at top of each message. 'this'/'here' = that file.",
    "Workspace root: " + wsRoot(),
    cwdLine,
    filesLine,
    pinsLine,
    cpLine,
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
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file and return its exact current contents. Use this to establish ground truth before ANY edit — never rely on memory of what a file contains. CRITICAL: if you edited this file earlier in the session and the context may have been trimmed, read it again before making another edit; your memory of its post-edit state is not reliable. Also use this whenever you are about to reference a specific line number, function name, or code snippet — verify it exists first. Returns contents truncated at 20 KB with a TRUNCATED marker if the file is large; use run_command with grep/sed/head to inspect specific regions of large files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write a brand-new file that does NOT yet exist. NEVER use this to overwrite or modify an existing file — use edit_file for that. Before calling this tool, call list_dir on the parent directory to confirm the file does not already exist; if it does, switch to edit_file. Parent directories are created automatically. After writing, call get_problems to check for immediate errors.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Make a TARGETED, minimal edit to an existing file: replace one exact unique snippet (old_string) with new text (new_string). PREREQUISITE: you MUST have called read_file on this path in the current session — if you have not, call read_file first. NEVER reconstruct file contents from memory after a context trim; your memory is unreliable. Rules: (1) change the minimum code needed — do not refactor, reformat, or touch unrelated lines; (2) old_string must be an exact verbatim copy including all whitespace and indentation; (3) if old_string is not unique, add more surrounding lines until it is; (4) if the fix requires touching a second file you weren't asked to change, call confirm_scope first. After calling this tool, call get_problems to check for errors introduced by the edit.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "list_dir", description: "List directory entries in a folder (directories end with /). Use this to confirm a path exists before passing it to read_file or write_file, and before creating a new file to check it does not already exist. Prefer this over guessing directory structure.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command and return stdout+stderr. The user must approve each call. Do NOT use for long-running servers — use start_server instead. BEFORE calling this tool for any mutating command (one that changes state, writes files, installs packages, runs migrations, etc.), state your hypothesis inline: 'I expect this to [result] because [reason].' After you receive the result, state whether your hypothesis was correct and what you learned. FOR DEBUGGING: never run the exact same failing command twice in a row without first changing something — if it failed, read the error, form a new hypothesis, and try a different approach or command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_document", description: "Extract text from a PDF/DOCX/DOC/RTF/ODT/HTML document, OR OCR the text from a screenshot/image (.png/.jpg/etc). Use instead of read_file for non-text files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "start_server", description: "Launch a long-running process (dev server) in the background; returns its initial output. User approves it.", parameters: { type: "object", properties: { command: { type: "string" }, name: { type: "string", description: "Friendly label, e.g. 'vite' or 'uvicorn'." } }, required: ["command"] } } },
  { type: "function", function: { name: "open_preview", description: "Open a URL in VS Code's built-in Simple Browser so the user can see the running UI.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "load_skill", description: "Load the full instructions for a named skill before doing that kind of task.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "update_plan", description: "Show/update a step-by-step plan as a live checklist. Call FIRST on any multi-step task to outline steps, then call again to mark progress. Keep exactly one item in_progress.", parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } } },
  { type: "function", function: { name: "search_code", description: "Search the entire codebase for a literal string or regex and return matching file:line results (up to 50 hits). ALWAYS call this before guessing a file path, function location, or variable name — never assume something is in a particular file without verifying. If you think a symbol is defined in file X, search for it first; you may be wrong. Also use this to check whether a pattern already exists before adding it (avoid duplicating code). Returns 'No matches' if nothing found — that is ground truth, not an error.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "get_problems", description: "Return the current errors and warnings from VS Code's Problems panel (diagnostics) across the workspace. Use before/after edits to see and fix compile/lint errors.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "remember", description: "Save a DURABLE fact to the repo's persistent memory (.localsre/memory.md) so it's available in EVERY future session, forever. Use for environment specifics (how to reach a cluster/service, proxies, kube-contexts, credential locations), decisions made, setup procedures, and anything the user tells you to remember. CHECK memory before asking the user something you may already know.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } } },
  { type: "function", function: { name: "change_dir", description: "Switch the working directory for ALL subsequent tool calls (run_command, file ops, list_dir). Persists for the whole session. Use instead of 'cd' in a shell command when you need to work in a different folder.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute or relative path to the target directory." } }, required: ["path"] } } },
  // --- discipline tools (enforce Claude-like patterns: hypothesis, scope, diff) ---
  { type: "function", function: { name: "show_diff", description: "Show a unified diff of the current on-disk state of a file versus its state at the start of the session (or vs. a provided baseline string). Call this AFTER every edit_file call to confirm the change is exactly what you intended before continuing. This is the primary way to verify an edit was applied correctly — check the diff, not your memory of what you passed to edit_file. Never declare a task done without having shown and reviewed the diff for every file you changed.", parameters: { type: "object", properties: { path: { type: "string", description: "File path to diff (relative to workspace root or absolute)." } }, required: ["path"] } } },
  { type: "function", function: { name: "confirm_scope", description: "Pause and ask the user for explicit permission before touching a file or making a change that was NOT part of the original request. Call this whenever fixing X requires modifying file Y (which was not mentioned), deleting or renaming something, changing a public API/interface, or making a structural refactor. State clearly: what you need to change, which file, why it is required, and what alternatives exist. Do NOT proceed with the out-of-scope change until the user replies. This prevents silent scope creep.", parameters: { type: "object", properties: { reason: { type: "string", description: "Why the out-of-scope change is needed." }, proposed_change: { type: "string", description: "Exact description of what you want to do (file, line, nature of change)." }, alternatives: { type: "string", description: "What you could do instead if the user says no." } }, required: ["reason", "proposed_change"] } } },
  { type: "function", function: { name: "state_hypothesis", description: "Record your current hypothesis — what you believe is true and why — before reading files or running commands to verify it. This enforces inspect-before-act discipline and prevents looping. Use it at the START of any investigation ('I believe the bug is in X because Y — I will verify by reading Z'), whenever you are about to try the same approach again ('My previous hypothesis was wrong because... my new hypothesis is...'), and any time you are uncertain ('I am not sure whether A or B causes this — I will check A first'). The hypothesis is shown to the user so they can correct wrong assumptions early.", parameters: { type: "object", properties: { hypothesis: { type: "string", description: "What you currently believe is true about the problem or codebase." }, will_verify_by: { type: "string", description: "The specific tool call or action you will take next to test this hypothesis." } }, required: ["hypothesis", "will_verify_by"] } } },
  { type: "function", function: { name: "pin_context", description: "Pin a key fact, decision, or finding to the session's persistent context so it survives context trims. Use whenever you discover something critical during investigation (a confirmed root cause, a key constraint, a decision the user made) that you cannot afford to lose after trim. Pinned items are injected into the system prompt on every round. Maximum 10 active pins; oldest is evicted when the cap is exceeded.", parameters: { type: "object", properties: { key: { type: "string", description: "Short label (e.g. 'root-cause', 'confirmed-path', 'user-decision')." }, value: { type: "string", description: "The fact to pin — keep under 200 chars." } }, required: ["key", "value"] } } },
  { type: "function", function: { name: "checkpoint_plan", description: "Save a structured snapshot of the current task state — what was found, what was changed, what is left — so the agent can resume accurately after a context trim. Call this: (1) after completing an investigation phase before moving to implementation; (2) after every 3rd file edit; (3) before any long-running command. Only one active checkpoint per session — calling again replaces the previous one.", parameters: { type: "object", properties: { problem: { type: "string", description: "One-sentence statement of the problem being solved." }, findings: { type: "string", description: "Key facts discovered so far." }, changes_made: { type: "string", description: "Summary of edits made so far (file, what changed, why)." }, remaining: { type: "string", description: "What still needs to be done." } }, required: ["problem", "remaining"] } } },
  // --- SRE connectors (read-only; creds from .localsre/secrets or env) ---
  { type: "function", function: { name: "datadog_query", description: "READ-ONLY Datadog: query metrics timeseries, search logs, or list alerting monitors. Needs DD_API_KEY+DD_APP_KEY in .localsre/secrets or env.", parameters: { type: "object", properties: { kind: { type: "string", enum: ["metrics", "logs", "monitors"] }, query: { type: "string", description: "metrics: a metric query like avg:system.cpu.user{service:x}; logs: a log search query like service:x status:error; monitors: optional name filter" }, from_minutes: { type: "number", description: "lookback window in minutes (default 60)" } }, required: ["kind"] } } },
  { type: "function", function: { name: "gcp_logs", description: "READ-ONLY Google Cloud Logging: read log entries with a filter (uses your gcloud auth).", parameters: { type: "object", properties: { filter: { type: "string", description: "Cloud Logging filter, e.g. resource.type=\"k8s_container\" severity>=ERROR" }, freshness: { type: "string", description: "e.g. 1h, 30m (default 1h)" }, limit: { type: "number" } }, required: ["filter"] } } },
  { type: "function", function: { name: "k8s_view", description: "READ-ONLY kubectl (get/describe/logs/top/events only — never mutates). Respects your shell env/proxy. Example args: 'get pods -n prod' or 'logs deploy/checkout -n prod --tail=100'.", parameters: { type: "object", properties: { args: { type: "string", description: "kubectl arguments WITHOUT the word kubectl" } }, required: ["args"] } } },
];

// ---------- SRE connectors (deterministic plumbing — the model uses these, it never builds them) ----------
function loadSecrets() {
  const out = { ...process.env };
  try {
    const p = path.join(wsRoot(), ".localsre", "secrets");
    if (fs.existsSync(p)) for (const ln of fs.readFileSync(p, "utf8").split("\n")) {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return out;
}

function httpJson(url, headers) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    fetch(url, { headers, signal: ctrl.signal })
      .then(async (r) => resolve(r.ok ? await r.json() : { _error: "HTTP " + r.status + ": " + (await r.text()).slice(0, 300) }))
      .catch((e) => resolve({ _error: String(e.message || e) }))
      .finally(() => clearTimeout(to));
  });
}

async function datadogQuery(args) {
  const env = loadSecrets();
  if (!env.DD_API_KEY || !env.DD_APP_KEY) return "ERROR: DD_API_KEY / DD_APP_KEY not set. Add them to .localsre/secrets (KEY=value lines) or export them.";
  const site = env.DD_SITE || "datadoghq.com";
  const H = { "DD-API-KEY": env.DD_API_KEY, "DD-APPLICATION-KEY": env.DD_APP_KEY, "Content-Type": "application/json" };
  const mins = Number(args.from_minutes) > 0 ? Number(args.from_minutes) : 60;
  const now = Math.floor(Date.now() / 1000);
  if (args.kind === "metrics") {
    if (!args.query) return "ERROR: metrics needs a query, e.g. avg:system.cpu.user{service:x}";
    const d = await httpJson(`https://api.${site}/api/v1/query?from=${now - mins * 60}&to=${now}&query=${encodeURIComponent(args.query)}`, H);
    if (d._error) return "Datadog error: " + d._error;
    const series = (d.series || []).map((s) => {
      const pts = (s.pointlist || []).filter((p) => p[1] != null);
      const last = pts.slice(-5).map((p) => p[1].toFixed(3)).join(", ");
      const max = pts.length ? Math.max(...pts.map((p) => p[1])).toFixed(3) : "n/a";
      return `${s.metric}{${(s.tag_set || []).join(",")}} points=${pts.length} max=${max} last5=[${last}]`;
    });
    return series.length ? series.join("\n") : "NO DATA RETURNED — the query matched no datapoints in this window. This does NOT mean the value is 0 or that the service is healthy; the metric name or window may be wrong. Verify the query before concluding anything.";
  }
  if (args.kind === "logs") {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(`https://api.${site}/api/v2/logs/events/search`, { method: "POST", headers: H, signal: ctrl.signal,
        body: JSON.stringify({ filter: { query: args.query || "*", from: "now-" + mins + "m", to: "now" }, page: { limit: 25 }, sort: "-timestamp" }) });
      if (!r.ok) return "Datadog logs error: HTTP " + r.status + " " + (await r.text()).slice(0, 200);
      const d = await r.json();
      const rows = (d.data || []).map((e) => { const a = e.attributes || {}; return `${a.timestamp || ""} [${a.status || ""}] ${a.service || ""}: ${String(a.message || "").split("\n")[0].slice(0, 180)}`; });
      return rows.length ? rows.join("\n") : "NO LOGS MATCHED — the filter returned nothing for this window. This does NOT prove there are no errors; the filter/service/status may be wrong. Do not conclude the service is healthy from this.";
    } catch (e) { return "Datadog logs error: " + (e.message || e); } finally { clearTimeout(to); }
  }
  if (args.kind === "monitors") {
    const d = await httpJson(`https://api.${site}/api/v1/monitor?monitor_tags=&name=${encodeURIComponent(args.query || "")}`, H);
    if (d._error) return "Datadog error: " + d._error;
    const rows = (Array.isArray(d) ? d : []).map((m) => `[${m.overall_state}] #${m.id} ${m.name}`);
    const alerting = rows.filter((r) => /\[(Alert|Warn|No Data)\]/.test(r));
    return (alerting.length ? "ALERTING/WARN:\n" + alerting.join("\n") + "\n\n" : "") + "All (" + rows.length + "):\n" + rows.slice(0, 40).join("\n");
  }
  return "ERROR: kind must be metrics|logs|monitors";
}

function gcpLogs(args) {
  return new Promise((resolve) => {
    const a = ["logging", "read", args.filter || "severity>=ERROR", "--freshness=" + (args.freshness || "1h"),
      "--limit=" + (Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 30),
      "--format=value(timestamp,severity,resource.labels.namespace_name,textPayload,jsonPayload.message)"];
    cp.execFile("gcloud", a, { env: execEnv(), maxBuffer: 5 * 1024 * 1024, timeout: 60000 }, (e, so, se) => {
      if (e && e.code === "ENOENT") return resolve("ERROR: gcloud not found on PATH.");
      if (so && so.trim()) return resolve(distill(so, 7000));
      // any non-zero exit OR non-empty stderr = a real failure, NOT an empty result — never report it as "no logs".
      if (e || (se && se.trim())) return resolve("gcloud FAILED (not an empty result): " + String(se || (e && e.message) || "").slice(0, 400) + "\nHint: check auth (gcloud auth login) and the filter. Do NOT conclude there are no logs.");
      resolve("NO LOG ENTRIES MATCHED the filter in this window. This is an empty MATCH, not proof of health — verify the filter is correct.");
    });
  });
}

function k8sView(args) {
  const raw = String(args.args || "").trim().replace(/^kubectl\s+/, "");
  // Reject shell metacharacters outright — defense in depth even though we use execFile (no shell).
  if (/[;&|`$<>(){}\n\\!]/.test(raw) || raw.includes("$(")) return Promise.resolve("ERROR: k8s_view rejects shell metacharacters. Pass plain kubectl arguments only.");
  const argv = raw.split(/\s+/).filter(Boolean);
  // Block kubectl flags that read/write local files, redirect auth, or hit the raw API (confused-deputy exfil).
  const BAD = /^(--kubeconfig|--server|-s|--token|--as|--as-group|--user|--cluster|--insecure-skip-tls-verify|--certificate-authority|--client-certificate|--client-key|--profile|--profile-output|--raw|--log-file|--flags-file)(=|$)/;
  for (const a of argv) {
    if (BAD.test(a)) return Promise.resolve("ERROR: that flag is not allowed in k8s_view (auth/file/raw redirection). Use plain read commands.");
    if (/^(-o|--output)$/.test(argv[argv.indexOf(a) - 1] || "") && /(file|template)/i.test(a)) return Promise.resolve("ERROR: file/template output formats are not allowed in k8s_view.");
    if (/^(-o|--output)=.*(file|template)/i.test(a)) return Promise.resolve("ERROR: file/template output formats are not allowed in k8s_view.");
  }
  const verb = argv[0] || "";
  if (!["get", "describe", "logs", "top", "events", "explain", "api-resources", "config", "version"].includes(verb))
    return Promise.resolve("ERROR: k8s_view is READ-ONLY (get/describe/logs/top/events/explain). For mutations use run_command (user approval).");
  if (verb === "config" && argv[1] !== "current-context" && argv[1] !== "get-contexts") return Promise.resolve("ERROR: only config current-context / get-contexts allowed here.");
  return new Promise((resolve) => {
    // execFile (NO shell) — argv passed directly; user's login env/proxy vars come from execEnv().
    cp.execFile("kubectl", argv, { env: execEnv(), maxBuffer: 5 * 1024 * 1024, timeout: 60000 }, (e, so, se) => {
      if (e && e.code === "ENOENT") return resolve("ERROR: kubectl not found on PATH.");
      if (so && so.trim()) return resolve(distill(so, 7000));
      resolve((se && se.trim()) ? "kubectl: " + se.slice(0, 500) : "(no output — command ran but returned nothing)");
    });
  });
}

// ---------- minimal MCP client (stdio JSON-RPC) — query ANY configured MCP server ----------
const mcpClients = {}; // name -> {child, buf, pending, tools}
let mcpTools = []; // dynamic TOOLS entries discovered from servers
function mcpSend(cli, msg) {
  const s = JSON.stringify(msg);
  try { cli.child.stdin.write("Content-Length: " + Buffer.byteLength(s) + "\r\n\r\n" + s); } catch (_) {} // child may have died (EPIPE)
}
function mcpRequest(cli, method, params, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const id = ++cli.seq;
    const to = setTimeout(() => { delete cli.pending[id]; resolve({ error: { message: "MCP timeout: " + method } }); }, timeoutMs);
    cli.pending[id] = (resp) => { clearTimeout(to); resolve(resp); };
    mcpSend(cli, { jsonrpc: "2.0", id, method, params });
  });
}
function mcpOnData(cli, chunk) {
  // Buffer-accurate framing: Content-Length is BYTES. Concatenating strings + slicing by chars
  // desyncs on any non-ASCII body and can wedge forever. Work in Buffers, slice by bytes.
  cli.buf = cli.buf && cli.buf.length ? Buffer.concat([cli.buf, chunk]) : Buffer.from(chunk);
  if (cli.buf.length > 16 * 1024 * 1024) { cli.buf = Buffer.alloc(0); return; } // runaway guard
  for (;;) {
    const header = cli.buf.toString("latin1", 0, Math.min(cli.buf.length, 4096));
    const m = header.match(/Content-Length: (\d+)\r?\n\r?\n/);
    if (!m) return;
    const start = m.index + m[0].length, len = parseInt(m[1], 10);
    if (cli.buf.length < start + len) return;
    const body = cli.buf.slice(start, start + len).toString("utf8");
    cli.buf = cli.buf.slice(start + len);
    try { const msg = JSON.parse(body); if (msg.id != null && cli.pending[msg.id]) { const cb = cli.pending[msg.id]; delete cli.pending[msg.id]; cb(msg); } } catch (_) {}
  }
}
async function mcpConnect(name, spec) {
  if (mcpClients[name]) return mcpClients[name];
  // Minimal env for third-party MCP subprocesses — do NOT forward the full secret set (ANTHROPIC/DD/SSO).
  // The server gets a clean base + only what the user explicitly declared in spec.env.
  const mcpEnv = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "TERM", "NODE_PATH"]) if (process.env[k]) mcpEnv[k] = process.env[k];
  const child = cp.spawn(spec.command, spec.args || [], { env: { ...mcpEnv, ...(spec.env || {}) }, cwd: wsRoot() });
  const cli = { child, buf: Buffer.alloc(0), pending: {}, seq: 0, tools: [] };
  child.stdout.on("data", (d) => mcpOnData(cli, d));
  child.on("error", (e) => { delete mcpClients[name]; mcpTools = mcpTools.filter((t) => t._mcp !== name); for (const id of Object.keys(cli.pending)) { try { cli.pending[id]({ error: { message: "MCP spawn error: " + e.message } }); } catch (_) {} } });
  child.on("exit", () => { delete mcpClients[name]; mcpTools = mcpTools.filter((t) => t._mcp !== name); });
  mcpClients[name] = cli;
  await mcpRequest(cli, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "localsre", version: "0.15.0" } });
  mcpSend(cli, { jsonrpc: "2.0", method: "notifications/initialized" });
  const resp = await mcpRequest(cli, "tools/list", {});
  const tools = (resp.result && resp.result.tools) || [];
  cli.tools = tools.map((t) => t.name);
  for (const t of tools) {
    mcpTools.push({ _mcp: name, type: "function", function: { name: "mcp_" + name + "_" + t.name, description: "[MCP:" + name + "] " + (t.description || t.name).slice(0, 300), parameters: t.inputSchema || { type: "object", properties: {} } } });
  }
  return cli;
}
async function mcpStartAll() {
  const conf = vscode.workspace.getConfiguration("localsre").get("mcpServers") || {};
  for (const [name, spec] of Object.entries(conf)) {
    if (spec && spec.command) { try { await mcpConnect(name, spec); } catch (e) { console.error("MCP " + name + ":", e.message); } }
  }
  return Object.keys(mcpClients);
}
async function mcpCall(toolName, args) {
  const t = mcpTools.find((x) => x.function.name === toolName);
  if (!t) return "ERROR: unknown MCP tool " + toolName;
  const cli = mcpClients[t._mcp];
  if (!cli) return "ERROR: MCP server " + t._mcp + " not connected.";
  const real = toolName.replace("mcp_" + t._mcp + "_", "");
  const resp = await mcpRequest(cli, "tools/call", { name: real, arguments: args }, 60000);
  if (resp.error) return "MCP error: " + (resp.error.message || JSON.stringify(resp.error)).slice(0, 400);
  const content = (resp.result && resp.result.content) || [];
  return distill(content.map((c) => c.text || JSON.stringify(c)).join("\n"), 7000) || "(empty result)";
}
// Sanitize a tool's JSON-Schema so ONE malformed MCP schema can't 400 the whole request.
function sanitizeSchema(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return { type: "object", properties: {} };
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") return { type: "object", properties: {} };
  // normalize union types (["string","null"]) → first non-null; drop $ref (providers reject it in tool schemas)
  const props = {};
  for (const [k, v] of Object.entries(s.properties)) {
    if (!v || typeof v !== "object" || v.$ref) { props[k] = { type: "string" }; continue; }
    const t = Array.isArray(v.type) ? v.type.find((x) => x !== "null") || "string" : v.type;
    props[k] = { ...v, type: t || "string" };
  }
  const out = { type: "object", properties: props };
  if (Array.isArray(s.required)) out.required = s.required.filter((r) => props[r]);
  return out;
}
function getTools() {
  return TOOLS.concat(mcpTools.map((t) => ({ ...t, function: { ...t.function, parameters: sanitizeSchema(t.function.parameters) } })));
}

// ---------- tool execution ----------
function sh(command) {
  return new Promise((resolve) => {
    cp.exec(command, { cwd: getCwd(), env: execEnv(), timeout: cmdTimeoutMs(), maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
      if (err && !out.trim()) out = "[exit " + (err.code ?? "?") + "] " + (err.message || "");
      resolve(clip(out.trim(), 20000) || "(no output)");
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
    const child = cp.spawn(command, { cwd: getCwd(), env: execEnv(), shell: true, detached: true });
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
      resolve("[" + (label || "server") + " started, pid " + child.pid + "]\n" + (capped ? "[⚠ early output may be missing — showing the tail only; check logs if startup errored]\n" : "") + (buf.slice(-3000) || "(no output yet)"));
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
  if (!postToWebview) return false; // no chat view → DENY (don't hang the run on an uncancellable modal)
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
      const fp = safePath(args.path);
      if (!fp) return "ERROR: path is outside the workspace (or is a protected file). I can only access files in this project.";
      const st = fs.statSync(fp);
      if (st.size > 5 * 1024 * 1024)
        return "ERROR: file too large (" + Math.round(st.size / 1e6) + " MB). Use run_command with grep/sed/head to inspect it.";
      sessionFiles.read.add(args.path);
      return clip(fs.readFileSync(fp, "utf8"), 20000);
    }
    if (name === "write_file") {
      const p = safePath(args.path);
      if (!p) return "ERROR: refusing to write outside the workspace.";
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content ?? "");
      sessionFiles.written.add(args.path);
      vscode.workspace.openTextDocument(p).then((d) => vscode.window.showTextDocument(d, { preview: false }), () => {});
      return `wrote ${args.path} (${(args.content || "").length} bytes)`;
    }
    if (name === "edit_file") {
      const fp = safePath(args.path);
      if (!fp) return "ERROR: refusing to edit outside the workspace.";
      let st; try { st = fs.statSync(fp); } catch (_) { return "ERROR: cannot read " + args.path + " (does it exist?)."; }
      if (st.size > 5 * 1024 * 1024) return "ERROR: file too large to edit inline (" + Math.round(st.size / 1e6) + " MB). Use run_command (sed) instead.";
      const src = fs.readFileSync(fp, "utf8");
      const oldS = String(args.old_string ?? ""), newS = String(args.new_string ?? "");
      if (!oldS) return "ERROR: old_string is empty.";
      const count = src.split(oldS).length - 1;
      if (count === 0) return "ERROR: old_string not found in " + args.path + " — read the file and copy an EXACT snippet (including whitespace).";
      if (count > 1) return "ERROR: old_string appears " + count + " times — add more surrounding context to make it unique.";
      fs.writeFileSync(fp, src.replace(oldS, newS));
      sessionFiles.written.add(args.path);
      vscode.workspace.openTextDocument(fp).then((d) => vscode.window.showTextDocument(d, { preview: false }), () => {});
      return "Edited " + args.path + " (−" + oldS.split("\n").length + " / +" + newS.split("\n").length + " lines).";
    }
    if (name === "list_dir") {
      const dp = safePath(args.path || ".");
      if (!dp) return "ERROR: path is outside the workspace.";
      return fs.readdirSync(dp, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
    }
    if (name === "change_dir") {
      const target = path.isAbsolute(args.path) ? args.path : path.join(getCwd(), args.path);
      return setCwd(target);
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
    if (name === "show_diff") {
      const fp = safePath(args.path);
      if (!fp) return "ERROR: path is outside the workspace.";
      if (!fs.existsSync(fp)) return "ERROR: file not found: " + args.path;
      return new Promise((resolve) => {
        cp.execFile("git", ["diff", "--", fp], { cwd: wsRoot(), env: execEnv(), maxBuffer: 2 * 1024 * 1024, timeout: 10000 }, (e, so, se) => {
          if (e && e.code === "ENOENT") return resolve("ERROR: git not found — cannot produce diff.");
          if (so && so.trim()) return resolve(clip(so, 12000));
          // No diff from git (untracked file or no changes); fall back to current contents.
          try {
            const cur = fs.readFileSync(fp, "utf8");
            return resolve("[File is untracked or has no unstaged diff in git. Current file contents:]\n" + clip(cur, 8000));
          } catch (err) { resolve("ERROR reading file for diff: " + (err.message || err)); }
        });
      });
    }
    if (name === "confirm_scope") {
      if (!postToWebview) return "BLOCKED: no chat panel available. Do not proceed with the out-of-scope change.";
      const approved = await approveCommand(args.proposed_change || "out-of-scope change", "confirm scope expansion");
      return approved ? "APPROVED — you may proceed with the proposed change." : "DENIED — do not make this change. Consider the alternatives or ask the user what to do instead.";
    }
    if (name === "state_hypothesis") {
      const text = "[Hypothesis] " + (args.hypothesis || "(none)") +
        (args.will_verify_by ? "\n[Will verify by] " + args.will_verify_by : "");
      if (postToWebview) postToWebview({ type: "hypothesis", text });
      return "Hypothesis recorded. Proceed with verification: " + (args.will_verify_by || "(no step specified — add one)");
    }
    if (name === "pin_context") {
      if (!args.key || !args.value) return "ERROR: key and value are required.";
      if (!sessionPins.has(args.key) && sessionPins.size >= PIN_CAP) {
        // evict oldest (Maps preserve insertion order)
        sessionPins.delete(sessionPins.keys().next().value);
      }
      sessionPins.set(String(args.key).slice(0, 60), String(args.value).slice(0, 200));
      return "Pinned: " + args.key + " = " + args.value;
    }
    if (name === "checkpoint_plan") {
      if (!args.problem || !args.remaining) return "ERROR: problem and remaining are required.";
      activeCheckpoint = {
        problem: String(args.problem).slice(0, 300),
        findings: String(args.findings || "").slice(0, 500),
        changes_made: String(args.changes_made || "").slice(0, 400),
        remaining: String(args.remaining).slice(0, 300),
      };
      return "Checkpoint saved. It is now in the system prompt and will survive context trims.";
    }
    if (name === "datadog_query") return await datadogQuery(args);
    if (name === "gcp_logs") return await gcpLogs(args);
    if (name === "k8s_view") return await k8sView(args);
    if (name.startsWith("mcp_")) return await mcpCall(name, args);
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

// Connectivity probe: which providers are reachable + a live 1-shot round-trip on the current model.
async function testConnection() {
  const lines = ["LocalSRE connection test", ""];
  let models = [];
  try { models = await listModels(); } catch (e) { lines.push("listModels error: " + (e.message || e)); }
  const byProv = {};
  for (const m of models) (byProv[m._p] = byProv[m._p] || []).push(m._m);
  lines.push("Providers reachable:");
  lines.push("  • local (Ollama/llama.cpp): " + ((byProv.local || []).length ? byProv.local.slice(0, 6).join(", ") : "— none (server not running?)"));
  lines.push("  • GitHub Copilot: " + ((byProv.copilot || []).length ? byProv.copilot.slice(0, 8).join(", ") : "— none (Copilot not signed in?)"));
  lines.push("  • Claude (Anthropic key): " + ((byProv.anthropic || []).length ? byProv.anthropic.join(", ") : "— no key set"));
  const claude = (byProv.copilot || []).find((m) => /claude/i.test(m));
  if (claude) lines.push("", "✅ Claude IS available via Copilot: " + claude + "  → pick it with the Model button.");
  // live round-trip on the CURRENT model
  lines.push("", "Round-trip test (" + curProvider() + ":" + curModel() + "):");
  const t0 = Date.now();
  try {
    const msg = await callModel([{ role: "system", content: "Connectivity probe. Reply with exactly: OK" }, { role: "user", content: "ping" }]);
    const txt = (stripThink(msg.content || "") || (msg.tool_calls ? "(tool_call)" : "(empty)")).slice(0, 60);
    lines.push("  ✅ responded in " + ((Date.now() - t0) / 1000).toFixed(1) + "s — \"" + txt + "\"");
  } catch (e) {
    lines.push("  ❌ FAILED in " + ((Date.now() - t0) / 1000).toFixed(1) + "s — " + (e.message || e));
  }
  const report = lines.join("\n");
  if (postToWebview) postToWebview({ type: "assistant", text: report });
  vscode.window.showInformationMessage(claude ? "Claude reachable via Copilot ✅ — see the LocalSRE panel for the full test." : "Connection test done — see the LocalSRE panel.");
  return report;
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
      body: JSON.stringify({ model: await localModelName(), messages, tools: getTools(), tool_choice: "auto", temperature: c.temperature, stream: !!onDelta }),
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
  } finally { clearTimeout(to); if (activeAbort === ctrl) activeAbort = null; } // don't null a NEWER call's controller
}

// Parse an OpenAI-style SSE stream: emit text deltas live, assemble tool_calls by index.
async function parseSSE(body, onDelta) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "";
  const toolMap = {};
  let lastIdx = -1; // carry-forward for servers that omit index on continuation fragments
  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim();
    if (d === "[DONE]" || !d) return;
    let j; try { j = JSON.parse(d); } catch (_) { return; }
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    // some servers put the assembled tool call in `message` on the terminal frame, not in `delta`
    const delta = ch.delta || ch.message;
    if (!delta) return;
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    for (const tcd of delta.tool_calls || []) {
      const idx = tcd.index != null ? tcd.index : (tcd.id ? ++lastIdx : (lastIdx < 0 ? (lastIdx = 0) : lastIdx));
      lastIdx = idx;
      const e = toolMap[idx] || (toolMap[idx] = { id: tcd.id || "", function: { name: "", arguments: "" } });
      if (tcd.id) e.id = tcd.id;
      if (tcd.function && tcd.function.name) e.function.name += tcd.function.name;
      if (tcd.function && tcd.function.arguments) e.function.arguments += tcd.function.arguments;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  buf += dec.decode(); // flush decoder
  if (buf.trim()) handleLine(buf); // process a final line that had no trailing newline
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
  const lmTools = getTools().map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
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

// Extract a useful summary from the messages being evicted so the model knows what happened
// in the trimmed portion — instead of a blank "context was cut here" marker.
function buildTrimSummary(dropped) {
  const filesRead = [], filesEdited = [], toolResults = [], assistantNotes = [];
  for (const m of (dropped || [])) {
    if (m.role === "tool" && m.content) toolResults.push(String(m.content).slice(0, 300));
    if (m.role === "assistant") {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
          if (tc.function.name === "read_file" && a.path) filesRead.push(a.path);
          if ((tc.function.name === "edit_file" || tc.function.name === "write_file") && a.path) filesEdited.push(a.path);
        }
      }
      if (typeof m.content === "string" && m.content.trim().length > 20)
        assistantNotes.push(m.content.trim().slice(0, 200));
    }
  }
  const parts = ["[CONTEXT TRIMMED — " + (dropped ? dropped.length : 0) + " earlier messages dropped to stay within limits.]"];
  if (filesRead.length)   parts.push("Files read in trimmed context: " + [...new Set(filesRead)].join(", ") + " (re-read only if you need lines beyond what is currently in context).");
  if (filesEdited.length) parts.push("Files edited in trimmed context: " + [...new Set(filesEdited)].join(", ") + " (listed under 'Files touched this session' — re-read before editing again).");
  if (toolResults.length) parts.push("Last " + Math.min(toolResults.length, 3) + " tool outputs (tail of trimmed window):\n" + toolResults.slice(-3).join("\n").slice(0, 600));
  if (assistantNotes.length) parts.push("Last assistant reasoning before trim: " + assistantNotes.slice(-1)[0]);
  parts.push("CRITICAL: re-read any file before editing — do NOT rely on memory of its contents. Check the current working directory in the system prompt before running commands.");
  return parts.join("\n");
}

function trimInPlace(messages) {
  if (messages.length <= HISTORY_CAP + 1) return; // +1 for system
  let start = messages.length - HISTORY_CAP;
  // Window must NOT start on a 'tool' (orphans it from its assistant → 400). Walk back past tool messages.
  while (start > 2 && messages[start].role === "tool") start--;
  // If walking back found no boundary (one huge unbroken tool-chain), walk FORWARD instead to a clean
  // start — this guarantees we always trim something (fixes the still-unbounded ≥40-tool-call turn).
  if (start <= 2) {
    start = messages.length - HISTORY_CAP;
    while (start < messages.length && messages[start].role === "tool") start++;
    if (start >= messages.length) return; // genuinely nothing safe to cut this round
  }
  const dropped = messages.slice(2, start); // capture BEFORE splice for the summary
  messages.splice(2, start - 2); // keep system(0) + first turn(1) + safe window
  // Guard: if first turn (index 1) is an assistant with tool_calls whose tool results we just cut,
  // drop it too so we never send a dangling tool_calls turn (400 on every provider).
  if (messages[1] && messages[1].role === "assistant" && messages[1].tool_calls && messages[1].tool_calls.length &&
      !(messages[2] && messages[2].role === "tool")) messages.splice(1, 1);
  // Always refresh the system prompt so sessionCwd + sessionFiles survive the trim.
  if (messages[0] && messages[0].role === "system") messages[0] = { role: "system", content: SYSTEM() };
  // Content-aware trim summary: extract key facts from the dropped messages instead of a generic warning.
  const trimSummary = buildTrimSummary(dropped);
  messages.splice(1, 0,
    { role: "user",      content: trimSummary },
    { role: "assistant", content: "Understood. Context trimmed. I will re-read files before editing and verify the working directory before running commands. Proceeding from the task state in the system prompt." });
}

// ---------- agent loop ----------
async function runAgent(userText, messages, post) {
  messages.push({ role: "user", content: userText });
  const c = cfg();
  const originalTask = String(userText).replace(/\[Editor context[\s\S]*?\[User request\]\n/, "").slice(0, 600); // anchor
  const callLog = {}; // detect repeated identical tool calls (local models tend to loop)
  let loopTrips = 0;  // total times the loop-guard tripped → hard-stop when stuck across actions
  let edited = false, verified = false, verifyNudges = 0; // self-verify loop state
  // SCOPE GUARD (change 5): track distinct files edited this task; prompt user before > 5 files.
  const sessionEditedFiles = new Set();
  let scopeGuardFired = false;
  // ANALYSIS PARALYSIS (change 2): count consecutive rounds with only read-only tools; nudge at 4.
  const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "search_code", "get_problems", "datadog_query", "gcp_logs", "k8s_view", "load_skill", "show_diff", "state_hypothesis"]);
  let readOnlyStreak = 0;
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
      messages.push({ role: "user", content: "[CHECKPOINT — not a new task] Re-read the ORIGINAL goal: \"" + originalTask + "\". Answer these three questions in one sentence each: (1) What have I verifiably completed (tool confirmed, not assumed)? (2) What is left? (3) Am I still in the right file/directory? If you have been repeating the same tool call or editing the same thing without progress, STOP, state what is blocking you, and ask the user one specific question. Do NOT restate what you already said. Then continue." });
      post({ type: "status", text: "↻ reflection checkpoint" });
    }
    // ANALYSIS PARALYSIS NUDGE (change 2): if the model has been reading/listing for 4+ rounds without
    // making any edit or running a command, it is stuck in exploration. Force it to commit.
    if (readOnlyStreak >= 4) {
      messages.push({ role: "user", content: "[ANALYSIS PARALYSIS] You have called only read-only tools for " + readOnlyStreak + " consecutive rounds without making any change or running any command. State your finding NOW: either (a) make the edit you've been exploring, or (b) explain one specific thing that is blocking you and ask the user for input. Do not read another file without first stating your conclusion from the ones you already read." });
      post({ type: "status", text: "nudge — analysis paralysis (" + readOnlyStreak + " read-only rounds)" });
      readOnlyStreak = 0; // reset so the nudge fires again if it persists
    }
    // PRE-TOOL HYPOTHESIS INJECTION (change 1): before every tool-calling round (after the first),
    // ask the model to state what it expects the tool to return. This forces reasoning before acting.
    // We skip round 0 — the model hasn't seen any results yet and needs to start somewhere.
    if (i > 0) {
      messages.push({ role: "user", content: "[HYPOTHESIS] Before calling any tool this round, state in one sentence: what do you expect to find, and why? If you already have enough information to act, state your conclusion and proceed directly to the change." });
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
    // content must be null ONLY when tool_calls are present; otherwise a string (Ollama/OpenAI reject content:null with no tool_calls).
    messages.push(toolCalls.length ? { role: "assistant", content: content || null, tool_calls: toolCalls } : { role: "assistant", content: content || "" });

    if (toolCalls.length) {
      if (content && !streamed) post({ type: "assistant", text: content });
      // Tools that are idempotent VERIFICATION steps — legit to repeat (test re-runs, re-checking
      // problems after a fix). Exempt from the loop-stop so we never kill a progressing task.
      const VERIFY_TOOLS = new Set(["get_problems", "run_command", "read_file", "search_code", "list_dir", "datadog_query", "gcp_logs", "k8s_view", "show_diff", "state_hypothesis"]);
      // Track whether ANY tool in this round is mutating — resets readOnlyStreak if so.
      let thisRoundHasMutation = false;
      for (const tc of toolCalls) {
        const tname = tc.function.name;
        if (tname === "write_file" || tname === "edit_file") { edited = true; thisRoundHasMutation = true; }
        if (tname === "run_command" || tname === "start_server") thisRoundHasMutation = true;
        if (tname === "get_problems" || tname === "run_command") verified = true;
        let args = {}, parseErr = null;
        try { args = JSON.parse(tc.function.arguments || "{}"); }
        catch (e) { parseErr = "Your tool arguments were not valid JSON (" + e.message + "). Re-emit this call with valid JSON arguments."; }

        // SCOPE GUARD (change 5): warn before editing more than 5 distinct files in one task.
        // We check BEFORE executing so the model gets the message on the next round and can pause.
        if ((tname === "write_file" || tname === "edit_file") && args.path && !parseErr) {
          sessionEditedFiles.add(path.resolve(resolvePath(String(args.path))));
          if (sessionEditedFiles.size > 5 && !scopeGuardFired) {
            scopeGuardFired = true;
            const fileList = Array.from(sessionEditedFiles).map((f) => "  - " + path.relative(wsRoot(), f)).join("\n");
            // Inject as a post-round user message — the model will see it before its next tool call.
            messages.push({ role: "user", content: "[SCOPE GUARD] You have now edited " + sessionEditedFiles.size + " distinct files in this task. This is more than expected for most tasks. Before editing more files, stop and state:\n1. What you changed in each file and why it was necessary for the original request:\n" + fileList + "\n2. Whether the original task actually required all of these changes.\nWait for the user to confirm before touching more files." });
            post({ type: "status", text: "scope guard — " + sessionEditedFiles.size + " files edited, pausing for user" });
          }
        }

        post({ type: "tool", name: tname, args });
        const sig = tname + "::" + (tc.function.arguments || "");
        callLog[sig] = (callLog[sig] || 0) + 1;
        let result;
        if (stopRequested) {
          result = "(stopped by user before this ran)";
        } else if (parseErr) {
          result = parseErr; // tell the model its JSON was bad instead of silently running defaults
        } else if (callLog[sig] >= 3 && !VERIFY_TOOLS.has(tname)) {
          loopTrips++;
          result = "LOOP DETECTED: you already made this exact call " + callLog[sig] + " times with the same arguments — the result will NOT change, so it was NOT run again. STOP. You must do ONE of: (A) take a completely different approach (different tool, different argument, different file), OR (B) state exactly what is blocking you and ask the user ONE specific question. Original goal: \"" + originalTask + "\".";
        } else {
          try { result = await execTool(tname, args); }
          catch (e) { result = "TOOL ERROR (" + tname + "): " + (e && e.message ? e.message : String(e)); }
        }
        post({ type: "toolResult", name: tname, result: String(result).slice(0, 4000) });
        // ALWAYS push a tool result for EVERY tc.id (even on stop/parse-error) — never leave a tool_calls turn unanswered (400s every future call).
        messages.push({ role: "tool", tool_call_id: tc.id, content: distill(result, 6000) });

        // DIFF AFTER EDIT (change 3): after any successful write/edit, run git diff and inject the
        // actual diff as context. This gives the model ground-truth about what changed — it can no
        // longer narrate a diff from memory or assume what it wrote.
        if ((tname === "write_file" || tname === "edit_file") && !stopRequested && args.path &&
            !String(result).startsWith("ERROR")) {
          const relPath = path.relative(wsRoot(), path.resolve(resolvePath(String(args.path))));
          const diffResult = await new Promise((resolve) => {
            cp.execFile("git", ["diff", "--unified=3", "--", relPath],
              { cwd: wsRoot(), env: execEnv(), maxBuffer: 512 * 1024, timeout: 10000 },
              (e, so, se) => {
                if (so && so.trim()) return resolve(so.trim());
                // File may be new (untracked) — show git diff --cached or just confirm the write.
                cp.execFile("git", ["diff", "--unified=3", "--cached", "--", relPath],
                  { cwd: wsRoot(), env: execEnv(), maxBuffer: 512 * 1024, timeout: 10000 },
                  (e2, so2) => resolve((so2 && so2.trim()) ? so2.trim() : "[file written — not yet tracked by git; no diff available]")
                );
              });
          }).catch(() => "[git not available in this workspace]");
          messages.push({ role: "user", content: "[ACTUAL DIFF for " + relPath + "]\n```diff\n" + clip(diffResult, 4000) + "\n```\nThis is what was actually written. Your summary must match this exactly — do not describe changes that are not in this diff." });
        }

        // ERROR INTERPRETATION PASS (change 4): when run_command exits with an error, force the model
        // to diagnose before retrying. Prevents the blind-retry loop that wastes tokens and context.
        if (tname === "run_command" && !stopRequested && !String(result).startsWith("DENIED") &&
            !String(result).startsWith("(stopped")) {
          const r = String(result);
          const looksLikeError = /\[exit [^0]\d*\]/.test(r) ||
            /\[stderr\]/i.test(r) ||
            /\bError[:\s]/i.test(r) ||
            /Traceback/.test(r) ||
            /\bfailed\b/i.test(r) ||
            /\bcommand not found\b/i.test(r) ||
            /\bno such file\b/i.test(r) ||
            /\bpermission denied\b/i.test(r);
          if (looksLikeError) {
            messages.push({ role: "user", content: "[COMMAND FAILED] The command above returned an error. Read the FULL output. State your diagnosis: what specifically went wrong? Do NOT retry the same command — first explain the root cause, then propose a fix." });
          }
        }
      }
      // Track read-only streak: reset if anything mutated this round, otherwise increment.
      readOnlyStreak = thisRoundHasMutation ? 0 : readOnlyStreak + 1;

      if (stopRequested) { post({ type: "assistant", text: "⏹ stopped." }); return; }
      if (loopTrips >= 3) { // stuck across multiple actions → stop instead of burning the whole budget
        post({ type: "assistant", text: "I'm stuck repeating actions without progress, so I've stopped. Here's the original goal: " + originalTask + ". Could you give me one concrete pointer, or should I try a different approach?" });
        return;
      }
      continue;
    }
    // No tool calls this round: model gave a text response. Reset read-only streak since it's done acting.

    // Self-verify: if we edited files but never checked them, run one verification pass first.
    if (edited && !verified && verifyNudges < 1) {
      verifyNudges++;
      messages.push({ role: "user", content: "You edited files but have not verified them. Before reporting done: (1) call get_problems, (2) run the relevant test or build command, (3) if errors appear, fix them and re-verify. Only after a clean verification pass should you give your final summary in the format: 'Changed <file>:<lines> — <what changed> — <why>. Verified: <how you confirmed it works>.'" });
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
      conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) || "(empty)" }] }); // Anthropic rejects empty tool_result content
    }
  }
  const tools = getTools().map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  while (conv.length && conv[0].role !== "user") conv.shift(); // Anthropic requires the first message to be 'user'
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
        // A queued message is a NEW turn → drop any stale steers (they belonged to the finished run,
        // must not leak into this unrelated task). Only when the queue is empty does a leftover steer
        // (typed in the run's dying moments) become its own turn.
        let text;
        if (this.queue.length) { text = this.queue.shift(); steerBuffer.length = 0; }
        else text = steerBuffer.shift();
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
    sessionCwd = null;
    sessionFiles.read.clear();
    sessionFiles.written.clear();
    sessionPins.clear();
    activeCheckpoint = null;
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
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    view.webview.html = getHtml(view.webview, mediaUri);
    const post = (m) => { try { view.webview.postMessage(m); } catch (_) {} };
    postToWebview = post; // enable inline approvals
    view.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === "ready") this._replay(); // webview is now listening → safe to restore history
        else if (m.type === "ask") {
          let text = m.text || "";
          // attachments: files/screenshots → extract text (OCR for images) and fold into the message
          if (Array.isArray(m.attachments) && m.attachments.length) {
            const parts = [];
            for (const a of m.attachments) {
              try {
                const dir = path.join(os.tmpdir(), "localsre-att"); fs.mkdirSync(dir, { recursive: true });
                const fp = path.join(dir, (Date.now() + "-" + (a.name || "file")).replace(/[^\w.\-]/g, "_"));
                fs.writeFileSync(fp, Buffer.from(a.b64 || "", "base64"));
                const content = await readDocument(fp);
                parts.push("[Attached file: " + (a.name || "file") + "]\n" + String(content).slice(0, 6000));
                try { fs.unlinkSync(fp); } catch (_) {}
              } catch (e) { parts.push("[Attached: " + (a.name || "file") + " — unreadable: " + (e.message || e) + "]"); }
            }
            text = parts.join("\n\n") + (text ? "\n\n" + text : "");
          }
          // Scope auto-loaded skills to the CURRENT request (last relevant set), capped — so the system
          // prompt doesn't grow forever with stale skill bodies across a long session.
          const rel = relevantSkills(text).slice(0, 3).map((s) => s.name);
          const before = activeSkills.size, had = new Set(activeSkills);
          activeSkills.clear(); rel.forEach((n) => activeSkills.add(n));
          const newly = rel.filter((n) => !had.has(n));
          if (newly.length || activeSkills.size !== before) {
            this.messages[0] = { role: "system", content: SYSTEM() }; // refresh system prompt with the current skills
            if (newly.length) post({ type: "status", text: "loaded skill: " + newly.join(", ") });
          }
          if (this.busy) {
            steerBuffer.push(withEditorContext(text)); // mid-run → STEER (abort in-flight so it reacts in seconds)
            if (activeAbort) { try { activeAbort.abort(); } catch (_) {} }
            post({ type: "status", text: "↪ got it — steering the current run" });
          } else {
            this.queue.push(withEditorContext(text));
            this._drain(post);
          }
        }
        else if (m.type === "reset") this.reset();
        else if (m.type === "switchModel") await vscode.commands.executeCommand("localsre.selectModel");
        else if (m.type === "approveResult") { const r = pendingApprovals[m.id]; if (r) r(!!m.approved); }
        else if (m.type === "stop") { stopRequested = true; this.queue.length = 0; steerBuffer.length = 0; for (const id of Object.keys(pendingApprovals)) pendingApprovals[id](false); if (activeAbort) { try { activeAbort.abort(); } catch (_) {} } post({ type: "status", text: "stopping…" }); }
      } catch (e) {
        // Never let an error escape into the extension host.
        post({ type: "error", text: "internal: " + (e && e.message ? e.message : String(e)) });
        post({ type: "done" });
      }
    });
    // On view disposal: clear stale refs (restores the modal fallback) and settle any pending approvals as denied.
    view.onDidDispose(() => {
      try {
        if (this.view === view) { this.view = null; postToWebview = null; }
        for (const id of Object.keys(pendingApprovals)) { const r = pendingApprovals[id]; if (r) r(false); }
      } catch (_) {}
    });
  }
}

function getHtml(webview, mediaUri) {
  const u = (f) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, f));
  const csp = "default-src 'none'; img-src " + webview.cspSource + " data: blob:; style-src " + webview.cspSource + " 'unsafe-inline'; script-src " + webview.cspSource + "; font-src " + webview.cspSource + ";";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
  *{box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:13.5px;line-height:1.65;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:0;height:100vh;}
  .root{display:flex;flex-direction:column;height:100vh;}

  /* log */
  .log{flex:1;overflow-y:auto;padding:16px 12px;display:flex;flex-direction:column;gap:4px;}

  /* avatar rows */
  .row{display:flex;gap:10px;align-items:flex-start;padding:4px 0;}
  .avatar{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px;}
  .user-avatar{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
  .agent-avatar{background:var(--vscode-badge-background,#0e639c);color:var(--vscode-badge-foreground,#fff);}
  .err-avatar{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:#f88;}

  /* bubbles */
  .bubble{flex:1;padding:8px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word;min-width:0;}
  .user-bubble{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.3));}
  .agent-bubble{background:transparent;}
  .err-bubble{background:var(--vscode-inputValidation-errorBackground,rgba(90,29,29,0.3));border-radius:8px;}
  .msg-text{white-space:pre-wrap;word-break:break-word;}

  /* code */
  .codeblock{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border,rgba(128,128,128,0.2));border-radius:6px;padding:10px 12px;font-family:var(--vscode-editor-font-family);font-size:12.5px;overflow-x:auto;margin:6px 0;}
  .inlinecode{background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:12px;padding:1px 5px;border-radius:4px;}

  /* tool chips */
  .tool-row{padding:2px 36px;}
  .toolwrap,.toolreswrap{margin:2px 0;}
  .toolchip,.toolreschip{display:flex;align-items:center;gap:6px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border,rgba(128,128,128,0.2));border-radius:6px;padding:4px 10px;font-family:var(--vscode-editor-font-family);font-size:12px;cursor:pointer;color:var(--vscode-editor-foreground);width:100%;text-align:left;}
  .toolchip:hover,.toolreschip:hover{border-color:var(--vscode-focusBorder);}
  .toolicon{opacity:.5;font-size:11px;}
  .toolname{font-weight:600;color:var(--vscode-symbolIcon-functionForeground,var(--vscode-charts-blue));}
  .toolargs{opacity:.55;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .toolcaret{opacity:.4;margin-left:auto;flex-shrink:0;}
  .tooldetail{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-top:none;border-radius:0 0 6px 6px;padding:8px 10px;font-family:var(--vscode-editor-font-family);font-size:11.5px;margin:0;overflow-x:auto;max-height:200px;overflow-y:auto;}
  .resicon{color:var(--vscode-charts-green,#4caf50);font-size:11px;}
  .resname{font-weight:600;opacity:.7;}
  .rescaret{opacity:.4;margin-left:auto;flex-shrink:0;}
  .toolresdetail,.toolrespreview{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-top:none;border-radius:0 0 6px 6px;padding:8px 10px;font-family:var(--vscode-editor-font-family);font-size:11.5px;margin:0;overflow-x:auto;max-height:220px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;}
  .toolrespreview{opacity:.75;}

  /* status */
  .status-row{display:flex;align-items:center;gap:8px;padding:4px 36px;color:var(--vscode-descriptionForeground);font-size:12.5px;}
  .status-dot{width:6px;height:6px;border-radius:50%;background:var(--vscode-charts-blue,#4fc3f7);animation:pulse 1.2s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
  .cursor{color:var(--vscode-charts-blue);animation:blink .9s step-end infinite;margin-left:36px;}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
  .note{color:var(--vscode-descriptionForeground);font-size:11.5px;text-align:center;padding:4px 0;opacity:.6;}

  /* approve card */
  .approve-card{margin:6px 36px;border:1px solid var(--vscode-inputValidation-warningBorder,#caa700);border-radius:8px;padding:10px 12px;background:var(--vscode-inputValidation-warningBackground,rgba(255,180,0,.08));}
  .approve-header{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
  .approve-title{font-weight:600;font-size:12.5px;}
  .approve-cmd{font-family:var(--vscode-editor-font-family);font-size:12px;background:var(--vscode-textCodeBlock-background);padding:8px 10px;border-radius:6px;margin:0 0 8px;white-space:pre-wrap;word-break:break-all;}
  .approve-actions{display:flex;gap:8px;}
  .btn-approve{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12.5px;font-weight:600;}
  .btn-deny{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12.5px;}
  .approve-done{font-size:12.5px;font-weight:600;opacity:.7;}

  /* plan bar */
  .plan-bar{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background));}
  .plan-title{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;opacity:.5;margin-bottom:6px;}
  .pstep{font-size:12.5px;padding:2px 0;display:flex;align-items:center;gap:6px;}
  .picon{width:14px;text-align:center;flex-shrink:0;}
  .pstep.pdone{opacity:.4;text-decoration:line-through;}
  .pstep.pcur{font-weight:600;color:var(--vscode-charts-blue);}

  /* input area */
  .input-area{border-top:1px solid var(--vscode-panel-border);padding:10px 10px 8px;background:var(--vscode-editor-background);}
  .input-box{display:flex;align-items:flex-end;gap:6px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.35));border-radius:10px;padding:6px 8px;}
  .input-box:focus-within{border-color:var(--vscode-focusBorder);}
  .inp{flex:1;resize:none;background:transparent;color:var(--vscode-input-foreground);border:none;outline:none;font-family:inherit;font-size:13.5px;line-height:1.5;min-height:22px;max-height:140px;overflow-y:auto;padding:0;}
  .inp-actions{display:flex;align-items:center;gap:2px;flex-shrink:0;}
  .icon-btn{background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);padding:3px 5px;border-radius:5px;font-size:14px;opacity:.7;line-height:1;}
  .icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);}
  .stop-btn{font-size:12px;}
  .send-btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .send-btn:hover{opacity:.85;}
  .toolbar{display:flex;gap:6px;margin-top:6px;}
  .tool-btn{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11.5px;}
  .tool-btn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-editor-foreground);}

  /* attachments */
  .att-bar{display:flex;flex-wrap:wrap;gap:6px;padding:4px 10px;}
  .att{display:flex;align-items:center;gap:4px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.3));border-radius:6px;padding:3px 8px;font-size:12px;}
  .att-img{height:20px;border-radius:3px;}
  .att-x{cursor:pointer;opacity:.5;font-weight:700;margin-left:2px;}
  .att-x:hover{opacity:1;}
  .atts{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
</style></head><body>
<div id="root"></div>
<script src="${u('react.min.js')}"></script>
<script src="${u('react-dom.min.js')}"></script>
<script src="${u('htm.min.js')}"></script>
<script src="${u('app.js')}"></script>
</body></html>`;
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
    vscode.commands.registerCommand("localsre.testConnection", () => testConnection()),
    vscode.commands.registerCommand("localsre.setClaudeKey", async () => {
      const k = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: "Anthropic API key (stored in the OS keychain, not settings)" });
      if (k) { await SECRETS.store("localsre.anthropicApiKey", k.trim()); vscode.window.showInformationMessage("Claude key saved to keychain."); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("localsre.endpoint") || e.affectsConfiguration("localsre.model")) autoLocalModel = null; // re-detect
    })
  );
  // connect configured MCP servers in the background (tools appear as mcp_<server>_<tool>)
  mcpStartAll().then((names) => { if (names.length && provider.view) provider.view.webview.postMessage({ type: "status", text: "MCP connected: " + names.join(", ") }); }).catch(() => {});
}
function deactivate() {
  for (const s of servers.slice()) killServer(s);
  for (const n of Object.keys(mcpClients)) { try { mcpClients[n].child.kill(); } catch (_) {} }
}
module.exports = { activate, deactivate };
// Test-only surface (harmless in production; used by test/run.js).
module.exports._test = { execTool, runAgent, callModel, loadSkills, getSkills: () => SKILLS, SYSTEM, relevantSkills };
