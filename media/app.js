/* LocalSRE chat UI — React (UMD, no build step) with file/screenshot attachments. */
(function () {
  const { useReducer, useEffect, useRef, useState } = React;
  const html = htm.bind(React.createElement);
  const vscode = acquireVsCodeApi();

  const init = { msgs: [], plan: [], status: "", streaming: false };
  function reducer(s, m) {
    switch (m.type) {
      case "_user": return { ...s, msgs: [...s.msgs, { role: "user", text: m.text, atts: m.atts || [] }], status: "" };
      case "status": return { ...s, status: m.text };
      case "assistantDelta": {
        const msgs = s.msgs.slice();
        if (s.streaming && msgs.length && msgs[msgs.length - 1].role === "assistant") {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], text: msgs[msgs.length - 1].text + m.text };
        } else msgs.push({ role: "assistant", text: m.text });
        return { ...s, msgs, streaming: true, status: "" };
      }
      case "assistantEnd": return { ...s, streaming: false };
      case "assistant": return { ...s, msgs: [...s.msgs, { role: "assistant", text: m.text }], streaming: false, status: "" };
      case "tool": return { ...s, msgs: [...s.msgs, { role: "tool", name: m.name, args: m.args }], status: "running…" };
      case "toolResult": return { ...s, msgs: [...s.msgs, { role: "toolres", name: m.name, text: m.result }], status: "" };
      case "error": return { ...s, msgs: [...s.msgs, { role: "error", text: m.text }], streaming: false, status: "" };
      case "model": return { ...s, msgs: [...s.msgs, { role: "note", text: "model → " + m.name }], status: "" };
      case "plan": return { ...s, plan: m.todos || [] };
      case "restore": return { ...s, msgs: (m.items || []).map((it) => ({ role: it.role === "user" ? "user" : "assistant", text: it.text })) };
      case "cleared": return { ...init };
      case "approve": return { ...s, msgs: [...s.msgs, { role: "approve", id: m.id, command: m.command, what: m.what, resolved: null }], status: "" };
      case "_approved": return { ...s, msgs: s.msgs.map((x) => (x.role === "approve" && x.id === m.id ? { ...x, resolved: m.approved } : x)) };
      case "done": return { ...s, status: "" };
      default: return s;
    }
  }

  function App() {
    const [s, dispatch] = useReducer(reducer, init);
    const [input, setInput] = useState("");
    const [atts, setAtts] = useState([]);
    const logRef = useRef(); const fileRef = useRef();

    useEffect(() => {
      const h = (ev) => dispatch(ev.data);
      window.addEventListener("message", h);
      vscode.postMessage({ type: "ready" });
      return () => window.removeEventListener("message", h);
    }, []);
    useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [s.msgs, s.status, s.plan]);

    function addFiles(files) {
      Array.from(files || []).forEach((f) => {
        const r = new FileReader();
        r.onload = () => {
          const d = String(r.result || ""); const b64 = d.slice(d.indexOf(",") + 1);
          setAtts((a) => [...a, { name: f.name || "file", mime: f.type || "", b64, preview: (f.type || "").startsWith("image/") ? d : null }]);
        };
        r.readAsDataURL(f);
      });
    }
    function onPaste(e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let n = 0;
      for (const it of items) {
        if (it.kind === "file") { const f = it.getAsFile(); if (f) { if (!f.name) Object.defineProperty(f, "name", { value: "screenshot-" + (++n) + ".png" }); addFiles([f]); } }
      }
    }
    function send() {
      const t = input.trim();
      if (!t && atts.length === 0) return;
      dispatch({ type: "_user", text: t || "(attachment)", atts: atts.map((a) => a.name) });
      vscode.postMessage({ type: "ask", text: t, attachments: atts.map((a) => ({ name: a.name, mime: a.mime, b64: a.b64 })) });
      setInput(""); setAtts([]);
    }
    const onKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

    return html`
      <div style=${{ display: "flex", flexDirection: "column", height: "100vh" }}>
        ${s.plan.length ? html`<div id="plan" style=${{ display: "block" }}>
          <div class="planhd">plan</div>
          ${s.plan.map((t, i) => html`<div key=${i} class=${"pstep " + (t.status === "completed" ? "pdone" : t.status === "in_progress" ? "pcur" : "")}>${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${t.content}</div>`)}
        </div>` : null}
        <div id="log" ref=${logRef}>
          ${s.msgs.map((m, i) => html`<${Msg} key=${i} m=${m} dispatch=${dispatch} />`)}
          ${s.status ? html`<div class="msg status">${s.status}</div>` : null}
        </div>
        ${atts.length ? html`<div class="atts">${atts.map((a, i) => html`<span class="att" key=${i}>${a.preview ? html`<img src=${a.preview}/>` : "📎"} ${a.name}<span class="x" onClick=${() => setAtts(atts.filter((_, j) => j !== i))}>×</span></span>`)}</div>` : null}
        <div id="bar">
          <textarea id="inp" rows="2" value=${input} placeholder="Ask LocalSRE… (Enter to send · 📎 or paste a screenshot)" onInput=${(e) => setInput(e.target.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
          <div style=${{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <button onClick=${send}>Send</button>
            <button class="iconbtn" onClick=${() => fileRef.current.click()}>📎 Attach</button>
            <button class="sec" onClick=${() => vscode.postMessage({ type: "stop" })}>⏹ Stop</button>
            <button class="sec" onClick=${() => vscode.postMessage({ type: "switchModel" })}>Model</button>
            <button class="sec" onClick=${() => vscode.postMessage({ type: "reset" })}>Reset</button>
          </div>
          <input ref=${fileRef} type="file" multiple style=${{ display: "none" }} onChange=${(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
      </div>`;
  }

  function Msg({ m, dispatch }) {
    if (m.role === "user") return html`<div class="msg user"><span class="label">you</span>${"\n" + m.text}${m.atts && m.atts.length ? html`<div class="atts">${m.atts.map((n, i) => html`<span class="att" key=${i}>📎 ${n}</span>`)}</div>` : null}</div>`;
    if (m.role === "assistant") return html`<div class="msg assistant"><span class="label">sre</span>${"\n" + m.text}</div>`;
    if (m.role === "tool") return html`<div class="msg tool">▶ ${m.name}(${JSON.stringify(m.args)})</div>`;
    if (m.role === "toolres") return html`<div class="msg toolres">${m.text}</div>`;
    if (m.role === "error") return html`<div class="msg assistant err">⚠ ${m.text}</div>`;
    if (m.role === "note") return html`<div class="msg status">${m.text}</div>`;
    if (m.role === "approve") return html`<div class="msg approve">
      <div class="label">approve · ${m.what}</div><pre class="cmd">${m.command}</pre>
      ${m.resolved === null
        ? html`<div class="approw">
            <button class="okbtn" onClick=${() => { vscode.postMessage({ type: "approveResult", id: m.id, approved: true }); dispatch({ type: "_approved", id: m.id, approved: true }); }}>✓ Approve</button>
            <button class="sec" onClick=${() => { vscode.postMessage({ type: "approveResult", id: m.id, approved: false }); dispatch({ type: "_approved", id: m.id, approved: false }); }}>✗ Deny</button>
          </div>`
        : html`<span class="adone">${m.resolved ? "✓ approved" : "✗ denied"}</span>`}
    </div>`;
    return null;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
})();
