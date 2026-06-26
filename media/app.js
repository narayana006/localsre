/* LocalSRE chat UI — Claude/Copilot-style clean layout */
(function () {
  const { useReducer, useEffect, useRef, useState } = React;
  const html = htm.bind(React.createElement);
  const vscode = acquireVsCodeApi();

  const init = { msgs: [], plan: [], status: "", streaming: false, t0: null };
  function reducer(s, m) {
    switch (m.type) {
      case "_user": return { ...s, msgs: [...s.msgs, { role: "user", text: m.text, atts: m.atts || [] }], status: "", t0: Date.now() };
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
      case "model": return { ...s, msgs: [...s.msgs, { role: "note", text: "switched to " + m.name }], status: "" };
      case "plan": return { ...s, plan: m.todos || [] };
      case "restore": return { ...s, msgs: (m.items || []).map((it) => ({ role: it.role === "user" ? "user" : "assistant", text: it.text })) };
      case "cleared": return { ...init };
      case "approve": return { ...s, msgs: [...s.msgs, { role: "approve", id: m.id, command: m.command, what: m.what, resolved: null }], status: "" };
      case "_approved": return { ...s, msgs: s.msgs.map((x) => (x.role === "approve" && x.id === m.id ? { ...x, resolved: m.approved } : x)) };
      case "done": {
        if (!s.t0) return { ...s, status: "" };
        const secs = ((Date.now() - s.t0) / 1000).toFixed(1);
        const msgs = s.msgs.slice();
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") { msgs[i] = { ...msgs[i], secs }; break; }
        }
        return { ...s, status: "", msgs, t0: null };
      }
      default: return s;
    }
  }

  // Render markdown-ish: fenced code blocks + inline `code`
  function renderText(text) {
    const parts = [];
    const fence = /```(\w*)\n?([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) parts.push(html`<span key=${last}>${renderInline(text.slice(last, m.index))}</span>`);
      parts.push(html`<pre key=${m.index} class="codeblock"><code>${m[2]}</code></pre>`);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(html`<span key=${last}>${renderInline(text.slice(last))}</span>`);
    return parts;
  }
  function renderInline(text) {
    const parts = [];
    const inline = /`([^`]+)`/g;
    let last = 0, m;
    while ((m = inline.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push(html`<code key=${m.index} class="inlinecode">${m[1]}</code>`);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  function ToolCall({ m }) {
    const [open, setOpen] = useState(false);
    const argStr = JSON.stringify(m.args || {});
    const short = argStr.length > 80 ? argStr.slice(0, 80) + "…" : argStr;
    return html`<div class="toolwrap">
      <button class="toolchip" onClick=${() => setOpen(!open)}>
        <span class="toolicon">⚙</span>
        <span class="toolname">${m.name}</span>
        <span class="toolargs">${short}</span>
        <span class="toolcaret">${open ? "▲" : "▼"}</span>
      </button>
      ${open ? html`<pre class="tooldetail">${JSON.stringify(m.args, null, 2)}</pre>` : null}
    </div>`;
  }

  function ToolResult({ m }) {
    const [open, setOpen] = useState(false);
    const lines = (m.text || "").split("\n").length;
    const preview = (m.text || "").split("\n").slice(0, 3).join("\n");
    const truncated = lines > 3;
    return html`<div class="toolreswrap">
      <button class="toolreschip" onClick=${() => setOpen(!open)}>
        <span class="resicon">✓</span>
        <span class="resname">${m.name}</span>
        <span class="rescaret">${open ? "▲" : "▼"}</span>
      </button>
      ${open
        ? html`<pre class="toolresdetail">${m.text}</pre>`
        : html`<pre class="toolrespreview">${preview}${truncated ? "\n…" : ""}</pre>`}
    </div>`;
  }

  function Msg({ m, dispatch }) {
    if (m.role === "user") return html`<div class="row user-row">
      <div class="avatar user-avatar">U</div>
      <div class="bubble user-bubble">
        <div class="msg-text">${renderText(m.text)}${m.atts && m.atts.length ? html`<div class="atts">${m.atts.map((n, i) => html`<span class="att" key=${i}>📎 ${n}</span>`)}</div>` : null}</div>
      </div>
    </div>`;

    if (m.role === "assistant") return html`<div class="row agent-row">
      <div class="avatar agent-avatar">S</div>
      <div class="bubble agent-bubble">
        <div class="msg-text">${renderText(m.text)}</div>
        ${m.secs ? html`<div class="msg-secs">⏱ ${m.secs}s</div>` : null}
      </div>
    </div>`;

    if (m.role === "tool") return html`<div class="tool-row"><${ToolCall} m=${m} /></div>`;
    if (m.role === "toolres") return html`<div class="tool-row"><${ToolResult} m=${m} /></div>`;

    if (m.role === "error") return html`<div class="row agent-row">
      <div class="avatar err-avatar">!</div>
      <div class="bubble err-bubble"><div class="msg-text">${m.text}</div></div>
    </div>`;

    if (m.role === "note") return html`<div class="note">${m.text}</div>`;

    if (m.role === "approve") return html`<div class="approve-card">
      <div class="approve-header">
        <span class="approve-icon">🔐</span>
        <span class="approve-title">Approve · ${m.what}</span>
      </div>
      <pre class="approve-cmd">${m.command}</pre>
      ${m.resolved === null
        ? html`<div class="approve-actions">
            <button class="btn-approve" onClick=${() => { vscode.postMessage({ type: "approveResult", id: m.id, approved: true }); dispatch({ type: "_approved", id: m.id, approved: true }); }}>✓ Approve</button>
            <button class="btn-deny" onClick=${() => { vscode.postMessage({ type: "approveResult", id: m.id, approved: false }); dispatch({ type: "_approved", id: m.id, approved: false }); }}>✗ Deny</button>
          </div>`
        : html`<div class="approve-done">${m.resolved ? "✓ Approved" : "✗ Denied"}</div>`}
    </div>`;
    return null;
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
      <div class="root">
        ${s.plan.length ? html`<div class="plan-bar">
          <div class="plan-title">Plan</div>
          ${s.plan.map((t, i) => html`<div key=${i} class=${"pstep" + (t.status === "completed" ? " pdone" : t.status === "in_progress" ? " pcur" : "")}>
            <span class="picon">${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}</span>
            ${t.content}
          </div>`)}
        </div>` : null}

        <div class="log" ref=${logRef}>
          ${s.msgs.map((m, i) => html`<${Msg} key=${i} m=${m} dispatch=${dispatch} />`)}
          ${s.status ? html`<div class="status-row">
            <span class="status-dot"></span><span class="status-text">${s.status}</span>
          </div>` : null}
          ${s.streaming ? html`<span class="cursor">▋</span>` : null}
        </div>

        ${atts.length ? html`<div class="att-bar">${atts.map((a, i) => html`<span class="att" key=${i}>
          ${a.preview ? html`<img src=${a.preview} class="att-img"/>` : "📎"} ${a.name}
          <span class="att-x" onClick=${() => setAtts(atts.filter((_, j) => j !== i))}>×</span>
        </span>`)}</div>` : null}

        <div class="input-area">
          <div class="input-box">
            <textarea class="inp" rows="1" value=${input}
              placeholder="Message LocalSRE…"
              onInput=${(e) => { setInput(e.target.value); e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,140)+"px"; }}
              onKeyDown=${onKey}
              onPaste=${onPaste}></textarea>
            <div class="inp-actions">
              <button class="icon-btn" title="Attach file" onClick=${() => fileRef.current.click()}>📎</button>
              <button class="icon-btn stop-btn" title="Stop" onClick=${() => vscode.postMessage({ type: "stop" })}>⏹</button>
              <button class="send-btn" onClick=${send} title="Send (Enter)">↑</button>
            </div>
          </div>
          <div class="toolbar">
            <button class="tool-btn" onClick=${() => vscode.postMessage({ type: "switchModel" })}>⚡ Model</button>
            <button class="tool-btn" onClick=${() => vscode.postMessage({ type: "reset" })}>↺ New chat</button>
          </div>
          <input ref=${fileRef} type="file" multiple style=${{ display: "none" }} onChange=${(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
      </div>`;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
})();
