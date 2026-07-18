import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHIPS, session } from "../lib/session";
import { useStore } from "../state/store";
import RepoPicker from "./RepoPicker";

export default function SidePanel() {
  const panelOpen = useStore((s) => s.panelOpen);
  const transcript = useStore((s) => s.transcript);
  const [text, setText] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    session.ask(t);
  };

  return (
    <aside id="panel" className={panelOpen ? "open" : ""}>
      <div className="panel-head">
        <span>Ask Forge</span>
        <button id="panel-close" onClick={() => session.closePanel()}>✕</button>
      </div>
      <RepoPicker />
      <div className="chips" id="chips">
        {CHIPS.map((q) => (
          <button key={q} onClick={() => session.ask(q)}>{q}</button>
        ))}
      </div>
      <div className="msgs" id="msgs" ref={msgsRef}>
        {transcript.map((m, i) => (
          <div key={i} className={"m" + (m.who === "Forge" ? " agent" : "")}>
            <div className="who">{m.who}</div>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
      <form className="panel-input" id="askform" onSubmit={submit}>
        <input
          id="askinput"
          type="text"
          placeholder="Type a question…"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit">➤</button>
      </form>
    </aside>
  );
}
