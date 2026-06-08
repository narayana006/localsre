// Verify every skill: parses (frontmatter), has name+description+body, and contains the
// commands/keywords it's supposed to. Runs without a model or VS Code.
const Module = require("module");
const path = require("path");
const vscodeStub = { workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [{ uri: { fsPath: process.cwd() } }] }, window: {}, commands: {} };
const origLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };
const T = require("../extension.js")._test;

// Each skill must exist and its body must contain ALL of these (case-insensitive).
const EXPECT = {
  "github-ops": ["git ", "gh ", "workflow", "pr create"],
  kubernetes: ["kubectl", "current-context", "rollout", "api-resources"],
  gcp: ["gcloud", "vertex", "dataflow", "dataproc", "kubectl", "--help"],
  "python-env": ["pip install", "venv"],
  homebrew: ["brew install"],
  documents: ["read_document", "textutil", "tesseract"],
  scaffold: ["vite", "fastapi", "streamlit", "npm"],
  datadog: ["DD_API_KEY", "monitor", "logs"],
  pagerduty: ["PD_API_TOKEN", "incidents", "oncall"],
  terraform: ["terraform plan", "terraform apply", "state"],
  helm: ["helm upgrade", "rollback", "repo add"],
  atlassian: ["jira", "confluence", "rest/api"],
  servicenow: ["service-now.com", "incident", "change_request", "table"],
};

T.loadSkills(path.join(__dirname, ".."));
const skills = T.getSkills();
const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; if (!c) console.log("  ❌ " + n); };

console.log(`loaded ${skills.length} skills\n`);
for (const [name, keywords] of Object.entries(EXPECT)) {
  const s = byName[name];
  console.log(`# ${name}`);
  ok(`${name} exists`, !!s);
  if (!s) continue;
  ok(`${name} has description`, s.description && s.description.length > 10);
  ok(`${name} has body`, s.body && s.body.length > 200);
  const body = (s.body || "").toLowerCase();
  for (const kw of keywords) ok(`${name} mentions "${kw}"`, body.includes(kw.toLowerCase()));
}
// no orphan skills missing from EXPECT
for (const s of skills) ok(`${s.name} is covered by tests`, !!EXPECT[s.name]);

Module._load = origLoad;
console.log(`\n${fail === 0 ? "🎉 ALL SKILLS VERIFIED" : "💥 FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
