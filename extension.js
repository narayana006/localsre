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
    endpoint: (c.get("endpoint") || "http://localhost:8080/v1").replace(/\/+$/, ""),
    model: c.get("model") || "local",
    temperature: Number.isFinite(c.get("temperature")) ? c.get("temperature") : 0.2,
    maxIterations: Number(c.get("maxIterations")) > 0 ? Number(c.get("maxIterations")) : 25,
    autoApprove: !!c.get("autoApproveCommands"),
    apiKey: c.get("apiKey") || "",
    provider: c.get("provider") || "local",
    anthropicApiKey: c.get("anthropicApiKey") || "",
  };
}

function wsRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : process.cwd();
}
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(wsRoot(), p || ".");
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

// ---------- skills ----------
let SKILLS = [];
function loadSkills(extPath) {
  SKILLS = [];
  const dir = path.join(extPath, "skills");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch (_) {}
  for (const f of files) {
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
  }
}

// ---------- system prompt (lean; capabilities live in skills) ----------
function SYSTEM() {
  const skillList = SKILLS.length ? SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "(none)";
  return [
    "You are LocalSRE, an autonomous coding agent inside the user's VS Code on macOS (M3 Pro).",
    "You build, fix, and run real software by USING TOOLS — never by guessing.",
    "",
    "## PERSISTENCE — your defining trait",
    "You HUNT for the solution. You never give up, apologize, or hand the task back.",
    "- On failure: read the error, form a NEW hypothesis, try a DIFFERENT concrete approach. Exhaust real options before concluding anything is impossible.",
    "- Never ask the user to run something you could run yourself — do it.",
    "- Keep iterating (hypothesis → tool → observe → adjust) until the task is COMPLETE and VERIFIED.",
    "",
    "## Skills — load on demand",
    "Skills are playbooks for specific jobs. Don't guess these workflows — call load_skill(name) to get the steps, then follow them:",
    skillList,
    "",
    "## Tools",
    "- read_file / write_file / list_dir — code.",
    "- read_document — PDF/DOCX/etc.",
    "- run_command — git, gh, kubectl, pip, brew, npm, tests (user approves each).",
    "- start_server — launch a long-running dev server in the BACKGROUND (don't use run_command for servers, it would block).",
    "- open_preview — open a URL in VS Code's built-in browser so the user can see the UI.",
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
function projectMemory() {
  for (const f of [".qwen/memory.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      const p = path.join(wsRoot(), f);
      if (!fs.existsSync(p)) continue;
      // read only the first 4000 bytes — never load a huge file into memory on the host thread
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(4000);
      const n = fs.readSync(fd, buf, 0, 4000, 0);
      fs.closeSync(fd);
      return "\n## Project memory (" + f + ")\n" + buf.slice(0, n).toString("utf8");
    } catch (_) {}
  }
  return "";
}

// DeepSeek-R1 emits chain-of-thought in <think>…</think>. Strip it for display + context.
function stripThink(t) {
  return (t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}
// Phrases that signal the model is bailing instead of solving → we nudge it to keep going.
const GIVEUP_RE =
  /\b(i'?m sorry|i apologize|i (can'?t|cannot|am unable|was unable)|would you like me to|let me know if you|you (can|could|should|may) (try|run|do|provide)|please (run|provide|try|let me)|i'?m not sure how|need more (info|information)|unable to (proceed|continue))\b/i;

// ---------- tool schemas ----------
const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file. Returns contents (truncated if large).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file. Parent dirs are created.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_dir", description: "List directory entries (dirs end with /).", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the workspace and return stdout+stderr. User approves it. Do NOT use for long-running servers — use start_server.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_document", description: "Extract text from a PDF/DOCX/DOC/RTF/ODT/HTML document, OR OCR the text from a screenshot/image (.png/.jpg/etc). Use instead of read_file for non-text files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "start_server", description: "Launch a long-running process (dev server) in the background; returns its initial output. User approves it.", parameters: { type: "object", properties: { command: { type: "string" }, name: { type: "string", description: "Friendly label, e.g. 'vite' or 'uvicorn'." } }, required: ["command"] } } },
  { type: "function", function: { name: "open_preview", description: "Open a URL in VS Code's built-in Simple Browser so the user can see the running UI.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "load_skill", description: "Load the full instructions for a named skill before doing that kind of task.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
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

async function approveCommand(command, what) {
  if (cfg().autoApprove) return true;
  const pick = await vscode.window.showWarningMessage("LocalSRE wants to " + (what || "run a command") + ":", { modal: true, detail: command }, "Approve", "Deny");
  return pick === "Approve";
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
    return "ERROR: unknown tool " + name;
  } catch (e) {
    return "ERROR: " + (e.message || String(e));
  }
}

// ---------- model selection (local endpoint + GitHub Copilot) ----------
const active = { provider: null, model: null }; // null = fall back to settings
function curProvider() { return active.provider || cfg().provider; }
function curModel() { return active.model || cfg().model; }

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
async function callModel(messages) {
  const p = curProvider();
  if (p === "copilot") return callModelLM(messages);
  if (p === "anthropic") return callModelAnthropic(messages);
  return callModelHTTP(messages);
}

async function callModelHTTP(messages) {
  const c = cfg();
  if (!c.endpoint) throw new Error("No endpoint configured (localsre.endpoint).");
  const headers = { "Content-Type": "application/json" };
  if (c.apiKey) headers["Authorization"] = "Bearer " + c.apiKey;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(c.endpoint + "/chat/completions", {
      method: "POST", headers, signal: ctrl.signal,
      body: JSON.stringify({ model: curModel(), messages, tools: TOOLS, tool_choice: "auto", temperature: c.temperature, stream: false }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error("Malformed response (no message).");
    return data.choices[0].message;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Model timed out (180s). Is the server running, or is the context too large?");
    throw e;
  } finally { clearTimeout(to); }
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
async function callModelLM(messages) {
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
      if (part instanceof vscode.LanguageModelTextPart) content += part.value;
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
function trimInPlace(messages) {
  if (messages.length <= HISTORY_CAP + 1) return; // +1 for the system message
  let start = messages.length - HISTORY_CAP;
  // start the window at a 'user' boundary so we never orphan a tool_calls/tool pair
  while (start < messages.length && messages[start].role !== "user") start++;
  if (start > 1) messages.splice(1, start - 1); // keep messages[0] (system) + the window
}

// ---------- agent loop ----------
async function runAgent(userText, messages, post) {
  messages.push({ role: "user", content: userText });
  const c = cfg();
  let nudges = 0;
  for (let i = 0; i < c.maxIterations; i++) {
    trimInPlace(messages); // bound prefill every iteration
    post({ type: "status", text: "thinking…" });
    let msg;
    try { msg = await callModel(messages); } catch (e) { post({ type: "error", text: String(e.message || e) }); return; }

    const content = stripThink(msg.content || "");
    // Keep only well-formed tool calls; give each a stable unique id reused in the tool result.
    const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((tc) => tc && tc.function && tc.function.name);
    toolCalls.forEach((tc, idx) => { if (!tc.id) tc.id = "call_" + i + "_" + idx; });
    // OpenAI protocol wants content:null (not "") when tool_calls are present.
    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined });

    if (toolCalls.length) {
      if (content) post({ type: "assistant", text: content });
      for (const tc of toolCalls) {
        const tname = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        post({ type: "tool", name: tname, args });
        const result = await execTool(tname, args);
        post({ type: "toolResult", name: tname, result: String(result).slice(0, 4000) });
        // Cap what goes back into context — keeps prefill fast on local hardware over long sessions.
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 6000) });
      }
      continue;
    }

    // No tool calls → either done, or trying to bail. If it's bailing, nudge it to keep hunting.
    if (GIVEUP_RE.test(content) && nudges < 2) {
      nudges++;
      if (content) post({ type: "assistant", text: content });
      post({ type: "status", text: "nudging the agent to keep going…" });
      messages.push({ role: "user", content: "Do not stop or hand this back. Keep using tools to make concrete progress and finish the task yourself. If something failed, try a different approach." });
      continue;
    }
    post({ type: "assistant", text: content || "(no content)" });
    return;
  }
  post({ type: "assistant", text: "⚠️ Stopped after " + c.maxIterations + " iterations." });
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
  }
  _load() {
    const saved = this.context.workspaceState.get("localsre.history");
    if (Array.isArray(saved) && saved.length) { saved[0] = { role: "system", content: SYSTEM() }; return saved; }
    return [{ role: "system", content: SYSTEM() }];
  }
  _save() {
    // system + last 60 turns, scoped to THIS workspace by VS Code automatically
    const tail = this.messages.slice(1).slice(-60);
    this.context.workspaceState.update("localsre.history", [{ role: "system", content: SYSTEM() }, ...tail]);
  }
  reset() {
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
    const post = (m) => view.webview.postMessage(m);
    this._replay(); // re-render this repo's prior conversation
    view.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === "ask") { await runAgent(m.text, this.messages, post); this._save(); post({ type: "done" }); }
        else if (m.type === "reset") this.reset();
        else if (m.type === "switchModel") await vscode.commands.executeCommand("localsre.selectModel");
      } catch (e) {
        // Never let an error escape into the extension host.
        post({ type: "error", text: "internal: " + (e && e.message ? e.message : String(e)) });
        post({ type: "done" });
      }
    });
  }
}

function getHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;display:flex;flex-direction:column;height:100vh;}
  #log{flex:1;overflow-y:auto;padding:10px;}
  .msg{margin:8px 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-wrap:break-word;}
  .user{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);}
  .assistant{background:var(--vscode-editor-inactiveSelectionBackground);}
  .tool{font-family:var(--vscode-editor-font-family);font-size:12px;background:var(--vscode-textCodeBlock-background);border-left:3px solid var(--vscode-charts-blue);padding:6px 8px;margin:4px 0;}
  .toolres{font-family:var(--vscode-editor-font-family);font-size:12px;color:var(--vscode-descriptionForeground);background:var(--vscode-textCodeBlock-background);padding:6px 8px;margin:2px 0 8px;max-height:160px;overflow:auto;border-left:3px solid var(--vscode-charts-green);}
  .err{color:var(--vscode-errorForeground);}
  .status{color:var(--vscode-descriptionForeground);font-style:italic;}
  #bar{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vscode-panel-border);}
  #inp{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:4px;padding:6px;font-family:inherit;}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:6px 10px;cursor:pointer;}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  .label{font-weight:600;opacity:.7;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}
</style></head><body>
<div id="log"></div>
<div id="bar">
  <textarea id="inp" rows="2" placeholder="Ask Qwen to build, fix, run… (Enter to send, Shift+Enter newline)"></textarea>
  <div style="display:flex;flex-direction:column;gap:4px;"><button id="send">Send</button><button id="model" class="sec">Model</button><button id="reset" class="sec">Reset</button></div>
</div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log'); const inp = document.getElementById('inp'); let statusEl=null;
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function add(cls,html){const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function clearStatus(){if(statusEl){statusEl.remove();statusEl=null;}}
function send(){const t=inp.value.trim();if(!t)return;add('user','<span class="label">you</span>\\n'+esc(t));inp.value='';vscode.postMessage({type:'ask',text:t});statusEl=add('status','…');}
document.getElementById('send').onclick=send;
document.getElementById('reset').onclick=()=>vscode.postMessage({type:'reset'});
document.getElementById('model').onclick=()=>vscode.postMessage({type:'switchModel'});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
window.addEventListener('message',ev=>{const m=ev.data;
  if(m.type==='status'){if(statusEl)statusEl.textContent=m.text;}
  else if(m.type==='assistant'){clearStatus();add('assistant','<span class="label">sre</span>\\n'+esc(m.text));}
  else if(m.type==='tool'){clearStatus();add('tool','▶ '+esc(m.name)+'('+esc(JSON.stringify(m.args))+')');statusEl=add('status','running…');}
  else if(m.type==='toolResult'){clearStatus();add('toolres',esc(m.result));}
  else if(m.type==='error'){clearStatus();add('assistant err','⚠ '+esc(m.text));}
  else if(m.type==='model'){clearStatus();add('status','model → '+esc(m.name));}
  else if(m.type==='restore'){log.innerHTML='';m.items.forEach(it=>add(it.role==='user'?'user':'assistant','<span class="label">'+(it.role==='user'?'you':'sre')+'</span>\\n'+esc(it.text)));}
  else if(m.type==='cleared'){log.innerHTML='';}
  else if(m.type==='done'){clearStatus();}
});
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
module.exports._test = { execTool, runAgent, callModel, loadSkills, getSkills: () => SKILLS };
