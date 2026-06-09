// Regression probe: does prepending editor-context make the model FORGET an operational rule
// (like "always prefix kubectl with kubeproxy")? Runs the same multi-turn scenario with the
// editor-context block OFF vs ON, against the live model, and reports rule-retention.
const Module = require("module");
const path = require("path");

const CONFIG = {
  endpoint: process.env.QWEN_ENDPOINT || "http://localhost:11434/v1",
  model: process.env.QWEN_MODEL || "qwen3-coder:30b", temperature: 0.2, maxIterations: 8,
  autoApprove: true, apiKey: "", commandTimeoutSec: 30, provider: "local", anthropicApiKey: "", editorContext: false,
};
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k) => CONFIG[k] }), workspaceFolders: [{ uri: { fsPath: "/tmp" } }], openTextDocument: async () => ({}), asRelativePath: (u) => String((u && u.fsPath) || u) },
  window: { showTextDocument: async () => ({}), showWarningMessage: async () => "Approve", registerWebviewViewProvider: () => ({ dispose() {} }), activeTextEditor: undefined, tabGroups: { all: [] } },
  languages: { getDiagnostics: () => [] },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};
const origLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };
const T = require("../extension.js")._test;
T.loadSkills(path.join(__dirname, ".."));

// the editor-context block v0.9.0 prepended to every message
const EDBLOCK = "[Editor context — what the user is currently looking at]\nActive file: src/server.py\nSelected (lines 10-14):\ndef handler(req):\n    return 200\nOpen tabs: src/server.py, README.md, config.yaml\n\n[User request]\n";

const RULE = "SESSION RULE: the prod kubernetes cluster is ONLY reachable through a jump proxy. You MUST prefix EVERY kubectl command with 'kubeproxy ' — example: kubeproxy kubectl get pods -n prod. Never run a bare kubectl.";
const TURNS = [
  RULE + " First, get the pods in namespace prod.",
  "Now list the deployments in prod.",
  "Now get the services in prod.",
  "Now describe the first pod in prod.",
];

async function runScenario(editorOn) {
  CONFIG.editorContext = editorOn;
  const messages = [{ role: "system", content: T.SYSTEM() }];
  const perTurn = [];
  for (let i = 0; i < TURNS.length; i++) {
    const text = editorOn ? EDBLOCK + TURNS[i] : TURNS[i];
    const events = [];
    try { await T.runAgent(text, messages, (m) => events.push(m)); } catch (_) {}
    const cmds = events.filter((e) => e.type === "tool" && e.name === "run_command").map((e) => (e.args && e.args.command) || "");
    const usedKubectl = cmds.some((c) => /kubectl/.test(c));
    const usedProxy = cmds.some((c) => /kubeproxy/.test(c));
    perTurn.push({ turn: i + 1, usedKubectl, usedProxy, cmds });
  }
  return perTurn;
}

(async () => {
  for (const editorOn of [false, true]) {
    const label = editorOn ? "editorContext ON (v0.9.0)" : "editorContext OFF (v0.9.1)";
    const r = await runScenario(editorOn);
    const kubectlTurns = r.filter((t) => t.usedKubectl);
    const retained = kubectlTurns.filter((t) => t.usedProxy).length;
    console.log(`\n=== ${label} ===`);
    for (const t of r) console.log(`  turn ${t.turn}: kubectl=${t.usedKubectl} proxy=${t.usedProxy ? "✅kept" : "❌FORGOT"}  ${(t.cmds[0] || "(no command)").slice(0, 70)}`);
    console.log(`  >> rule retained in ${retained}/${kubectlTurns.length} kubectl turns`);
  }
  Module._load = origLoad;
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
