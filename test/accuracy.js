// Accuracy regression grader. For each scenario: load the skill, ask the model, then score
// must_include (correct commands/facts present) and must_not_include (hallucination/danger present).
// Usage: QWEN_ENDPOINT=http://localhost:11434/v1 QWEN_MODEL=qwen3-coder:30b PER_SKILL=8 node test/accuracy.js
const fs = require("fs");
const path = require("path");
const ENDPOINT = (process.env.QWEN_ENDPOINT || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.QWEN_MODEL || "qwen3-coder:30b";
const PER = Number(process.env.PER_SKILL) || 8;
const ONLY = process.env.ONLY_SKILL; // optional: grade one skill
const SKILLS = path.join(__dirname, "..", "skills");
const SCEN = path.join(__dirname, "scenarios");
const CONC = Number(process.env.CONC) || 4; // parallel requests

function skillBody(name) {
  try { const raw = fs.readFileSync(path.join(SKILLS, name + ".md"), "utf8"); const m = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/); return (m ? m[1] : raw).trim(); } catch (_) { return ""; }
}
async function ask(skill, prompt) {
  const sys = "You are LocalSRE, an expert SRE/coding assistant. Use this reference playbook to answer with the EXACT commands, flags, and API paths.\n\n" + skillBody(skill) + "\n\nAnswer the request concisely with the specific commands/approach. Do not ask clarifying questions — give the best concrete answer.";
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: prompt }], temperature: 0.1, stream: false }) });
    const d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  } catch (_) { return ""; } finally { clearTimeout(to); }
}
async function pool(items, fn, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

(async () => {
  let files = fs.readdirSync(SCEN).filter((f) => f.endsWith(".json")).sort();
  if (ONLY) files = files.filter((f) => f === ONLY + ".json");
  console.log(`model=${MODEL}  per_skill=${PER}  skills=${files.length}\n`);
  const results = [];
  for (const f of files) {
    const skill = f.replace(".json", "");
    const scen = JSON.parse(fs.readFileSync(path.join(SCEN, f))).scenarios.slice(0, PER);
    const graded = await pool(scen, async (s) => {
      const ans = (await ask(skill, s.prompt)).toLowerCase();
      const inc = (s.must_include || []).map((x) => String(x).toLowerCase()).filter(Boolean);
      const exc = (s.must_not_include || []).map((x) => String(x).toLowerCase()).filter(Boolean);
      const hit = inc.filter((x) => ans.includes(x)).length;
      const viol = exc.some((x) => ans.includes(x));
      return { hit, incTot: inc.length, viol, pass: (inc.length ? hit === inc.length : true) && !viol };
    }, CONC);
    const pass = graded.filter((g) => g.pass).length;
    const incHit = graded.reduce((a, g) => a + g.hit, 0), incTot = graded.reduce((a, g) => a + g.incTot, 0);
    const viol = graded.filter((g) => g.viol).length;
    const acc = (pass / scen.length * 100), cov = incTot ? (incHit / incTot * 100) : 100;
    results.push({ skill, n: scen.length, pass, acc, cov, viol });
    console.log(`  ${acc >= 80 ? "✅" : acc >= 60 ? "🟡" : "❌"} ${skill.padEnd(20)} strict=${acc.toFixed(0)}% (${pass}/${scen.length})  coverage=${cov.toFixed(0)}%  hallucination-hits=${viol}`);
  }
  const totN = results.reduce((a, r) => a + r.n, 0), totP = results.reduce((a, r) => a + r.pass, 0);
  const totCov = results.reduce((a, r) => a + r.cov, 0) / results.length, totViol = results.reduce((a, r) => a + r.viol, 0);
  console.log(`\n[[ACCURACY]] ${PER}/skill × ${results.length} = ${totN} scenarios`);
  console.log(`  strict-pass (all must_include + no hallucination) = ${(totP / totN * 100).toFixed(1)}%`);
  console.log(`  avg coverage (fraction of expected facts produced)  = ${totCov.toFixed(1)}%`);
  console.log(`  total hallucination/danger hits = ${totViol} / ${totN}`);
  fs.writeFileSync(path.join(__dirname, "accuracy-result.json"), JSON.stringify({ model: MODEL, per: PER, results, overall: { strictPass: totP / totN, coverage: totCov / 100, hallucinations: totViol, n: totN } }, null, 2));
})();
