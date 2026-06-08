// Qwen Coder — lightweight local agentic coding assistant for VS Code.
// Talks to a local OpenAI-compatible server (llama.cpp `llama-server --jinja`)
// and drives a local model (Qwen3-Coder / DeepSeek-Coder-V2-Lite / DeepSeek-R1)
// through a real tool-calling agent loop with a skills system.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- config ----------
function cfg() {
  const c = vscode.workspace.getConfiguration("qwenCoder");
  return {
    endpoint: (c.get("endpoint") || "").replace(/\/+$/, ""),
    model: c.get("model"),
    temperature: c.get("temperature"),
    maxIterations: c.get("maxIterations"),
    autoApprove: c.get("autoApproveCommands"),
    apiKey: c.get("apiKey"),
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
  return (vscode.workspace.getConfiguration("qwenCoder").get("commandTimeoutSec") || 900) * 1000;
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
    "You are Qwen Coder, an autonomous coding agent inside the user's VS Code on macOS (M3 Pro).",
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
  ].join("\n");
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
function startServer(command, label) {
  return new Promise((resolve) => {
    const child = cp.spawn(command, { cwd: wsRoot(), env: execEnv(), shell: true });
    servers.push({ child, label: label || command });
    let buf = "";
    const onData = (d) => { buf += d.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { buf += "\n[spawn error] " + e.message; });
    // give it a few seconds to print its startup banner / URL
    setTimeout(() => resolve("[" + (label || "server") + " started, pid " + child.pid + "]\n" + (buf.slice(-3000) || "(no output yet)")), 5000);
  });
}

async function readDocument(p) {
  if (!fs.existsSync(p)) return "ERROR: file not found: " + p;
  const ext = path.extname(p).toLowerCase();
  const q = '"' + p.replace(/"/g, '\\"') + '"';
  const run = (cmd) => new Promise((res) => cp.exec(cmd, { env: execEnv(), maxBuffer: 50 * 1024 * 1024, timeout: 180000 }, (e, so, se) => res({ so: so || "", se: se || "", e })));
  if ([".docx", ".doc", ".rtf", ".odt", ".html", ".htm", ".webarchive"].includes(ext)) {
    const r = await run(`textutil -convert txt -stdout ${q}`);
    return r.so.trim() ? clip(r.so) : "ERROR(textutil): " + (r.se || "no text");
  }
  if (ext === ".pdf") {
    let r = await run(`command -v pdftotext >/dev/null 2>&1 && pdftotext -layout ${q} -`);
    if (r.so.trim()) return clip(r.so);
    const py =
      "python3 - <<'PYEOF'\nimport sys\ntry:\n    from pypdf import PdfReader\nexcept Exception:\n    import subprocess; subprocess.run([sys.executable,'-m','pip','install','-q','pypdf'])\n    from pypdf import PdfReader\n" +
      "r=PdfReader(" + JSON.stringify(p) + ")\nprint('\\n'.join((pg.extract_text() or '') for pg in r.pages))\nPYEOF";
    r = await run(py);
    return r.so.trim() ? clip(r.so) : "ERROR: PDF extraction failed. Try `brew install poppler`. " + (r.se || "").slice(0, 200);
  }
  // Screenshots / images → OCR the text (text-only models can't see layout, but can read the words).
  if ([".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".gif", ".webp"].includes(ext)) {
    const r = await run(`command -v tesseract >/dev/null 2>&1 && tesseract ${q} - 2>/dev/null`);
    if (r.so.trim()) return "[OCR text extracted from image — visual layout NOT available]\n\n" + clip(r.so);
    return "ERROR: OCR needs tesseract. Install it: `brew install tesseract`, then retry. (Note: this reads TEXT in the image only; the model cannot see the actual picture.)";
  }
  try { return clip(fs.readFileSync(p, "utf8")); } catch (_) { return "ERROR: unsupported type " + ext; }
}

async function approveCommand(command, what) {
  if (cfg().autoApprove) return true;
  const pick = await vscode.window.showWarningMessage("Qwen Coder wants to " + (what || "run a command") + ":", { modal: true, detail: command }, "Approve", "Deny");
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
      vscode.workspace.openTextDocument(p).then((d) => vscode.window.showTextDocument(d, { preview: false }));
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

// ---------- model call ----------
async function callModel(messages) {
  const c = cfg();
  const headers = { "Content-Type": "application/json" };
  if (c.apiKey) headers["Authorization"] = "Bearer " + c.apiKey;
  const res = await fetch(c.endpoint + "/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({ model: c.model, messages, tools: TOOLS, tool_choice: "auto", temperature: c.temperature, stream: false }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error("No choices in response");
  return data.choices[0].message;
}

// ---------- agent loop ----------
async function runAgent(userText, messages, post) {
  messages.push({ role: "user", content: userText });
  const c = cfg();
  let nudges = 0;
  for (let i = 0; i < c.maxIterations; i++) {
    post({ type: "status", text: "thinking…" });
    let msg;
    try { msg = await callModel(messages); } catch (e) { post({ type: "error", text: String(e.message || e) }); return; }

    const content = stripThink(msg.content || "");
    messages.push({ role: "assistant", content, tool_calls: msg.tool_calls || undefined });

    if (msg.tool_calls && msg.tool_calls.length) {
      if (content) post({ type: "assistant", text: content });
      for (const tc of msg.tool_calls) {
        const tname = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        post({ type: "tool", name: tname, args });
        const result = await execTool(tname, args);
        post({ type: "toolResult", name: tname, result: String(result).slice(0, 4000) });
        // Cap what goes back into context — keeps prefill fast on local hardware over long sessions.
        messages.push({ role: "tool", tool_call_id: tc.id || tname, content: String(result).slice(0, 6000) });
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

// ---------- webview ----------
class ChatProvider {
  constructor() { this.messages = [{ role: "system", content: SYSTEM() }]; }
  reset() { this.messages = [{ role: "system", content: SYSTEM() }]; if (this.view) this.view.webview.postMessage({ type: "cleared" }); }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml();
    const post = (m) => view.webview.postMessage(m);
    view.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === "ask") { await runAgent(m.text, this.messages, post); post({ type: "done" }); }
        else if (m.type === "reset") this.reset();
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
  <div style="display:flex;flex-direction:column;gap:4px;"><button id="send">Send</button><button id="reset" class="sec">Reset</button></div>
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
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
window.addEventListener('message',ev=>{const m=ev.data;
  if(m.type==='status'){if(statusEl)statusEl.textContent=m.text;}
  else if(m.type==='assistant'){clearStatus();add('assistant','<span class="label">qwen</span>\\n'+esc(m.text));}
  else if(m.type==='tool'){clearStatus();add('tool','▶ '+esc(m.name)+'('+esc(JSON.stringify(m.args))+')');statusEl=add('status','running…');}
  else if(m.type==='toolResult'){clearStatus();add('toolres',esc(m.result));}
  else if(m.type==='error'){clearStatus();add('assistant err','⚠ '+esc(m.text));}
  else if(m.type==='cleared'){log.innerHTML='';}
  else if(m.type==='done'){clearStatus();}
});
</script></body></html>`;
}

// ---------- activation ----------
function activate(context) {
  loadSkills(context.extensionPath);
  const provider = new ChatProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("qwenCoder.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("qwenCoder.openChat", () => vscode.commands.executeCommand("qwenCoder.chat.focus")),
    vscode.commands.registerCommand("qwenCoder.reset", () => provider.reset())
  );
}
function deactivate() {
  for (const s of servers) { try { s.child.kill(); } catch (_) {} }
}
module.exports = { activate, deactivate };
// Test-only surface (harmless in production; used by test/run.js).
module.exports._test = { execTool, runAgent, callModel, loadSkills, getSkills: () => SKILLS };
