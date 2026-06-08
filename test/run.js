// Standalone test: stubs the `vscode` module + the model server, then drives the
// REAL extension code (agent loop + tools) to prove the plumbing works without VS Code or an LLM.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- sandbox workspace ---
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-test-"));
let approvals = 0;

// --- stub the `vscode` module ---
const CONFIG = {
  endpoint: "http://mock/v1", model: "test", temperature: 0.2,
  maxIterations: 25, autoApprove: false, apiKey: "", commandTimeoutSec: 60,
};
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k) => CONFIG[k] }),
    workspaceFolders: [{ uri: { fsPath: WS } }],
    openTextDocument: async () => ({}),
  },
  window: {
    showTextDocument: async () => ({}),
    showWarningMessage: async () => { approvals++; return "Approve"; }, // auto-approve in tests
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return origLoad.apply(this, arguments);
};

// --- mock the model server (scripted tool-calling conversation) ---
let turn = 0;
const SCRIPT = [
  { message: { role: "assistant", content: "Listing the workspace.", tool_calls: [{ id: "t1", function: { name: "list_dir", arguments: '{"path":"."}' } }] } },
  { message: { role: "assistant", content: "Creating a file.", tool_calls: [{ id: "t2", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hi from qwen" }) } }] } },
  { message: { role: "assistant", content: "Reading it back.", tool_calls: [{ id: "t3", function: { name: "read_file", arguments: '{"path":"hello.txt"}' } }] } },
  { message: { role: "assistant", content: "Running a command.", tool_calls: [{ id: "t4", function: { name: "run_command", arguments: '{"command":"echo AGENT_OK"}' } }] } },
  { message: { role: "assistant", content: "Loading a skill.", tool_calls: [{ id: "t5", function: { name: "load_skill", arguments: '{"name":"gcp"}' } }] } },
  { message: { role: "assistant", content: "Done — created hello.txt, ran the command, and reviewed the gcp skill." } },
];
global.fetch = async () => ({ ok: true, json: async () => ({ choices: [SCRIPT[turn++]] }), text: async () => "" });

// --- run ---
const ext = require("../extension.js");
const T = ext._test;

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { (cond ? pass++ : fail++); console.log((cond ? "  ✅ " : "  ❌ ") + name); };

  console.log("workspace:", WS);
  console.log("\n[1] skills load");
  T.loadSkills(path.join(__dirname, ".."));
  const skills = T.getSkills();
  ok("loaded 13 skills", skills.length === 13);
  ok("gcp skill has a body", !!skills.find((s) => s.name === "gcp" && s.body.length > 100));

  console.log("\n[2] individual tools");
  ok("write_file creates file", (await T.execTool("write_file", { path: "a.txt", content: "X" })).includes("wrote"));
  ok("file actually on disk", fs.existsSync(path.join(WS, "a.txt")));
  ok("read_file returns content", (await T.execTool("read_file", { path: "a.txt" })) === "X");
  ok("list_dir shows file", (await T.execTool("list_dir", { path: "." })).includes("a.txt"));
  ok("run_command runs (approved)", (await T.execTool("run_command", { command: "echo HELLO" })).includes("HELLO"));
  ok("read_document on .txt", (await T.execTool("read_document", { path: "a.txt" })) === "X");
  ok("load_skill returns body", (await T.execTool("load_skill", { name: "kubernetes" })).includes("kubectl"));
  ok("unknown tool handled", (await T.execTool("nope", {})).includes("unknown tool"));
  ok("read_file missing file → error not crash", (await T.execTool("read_file", { path: "ghost.txt" })).startsWith("ERROR"));

  console.log("\n[3] full agent loop (mock model, 6 turns)");
  const events = [];
  await T.runAgent("build a hello file and verify", [{ role: "system", content: "sys" }], (m) => events.push(m));
  const toolEvents = events.filter((e) => e.type === "tool").map((e) => e.name);
  ok("agent called list_dir", toolEvents.includes("list_dir"));
  ok("agent called write_file", toolEvents.includes("write_file"));
  ok("agent called run_command", toolEvents.includes("run_command"));
  ok("agent loaded a skill", toolEvents.includes("load_skill"));
  ok("hello.txt was created by agent", fs.existsSync(path.join(WS, "hello.txt")));
  const last = events.filter((e) => e.type === "assistant").pop();
  ok("agent gave final answer", last && last.text.includes("Done"));
  ok("command approval was requested", approvals >= 1);

  console.log("\n[4] crash-safety");
  ok("huge-path read doesn't throw", typeof (await T.execTool("read_file", { path: "/dev/null" })) === "string");

  Module._load = origLoad;
  console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "💥 FAILURES"} — ${pass} passed, ${fail} failed`);
  fs.rmSync(WS, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
