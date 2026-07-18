import { useEffect, useState } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

export default function ControlBar() {
  const micOn = useStore((s) => s.micOn);
  const camOn = useStore((s) => s.camOn);
  const ccOn = useStore((s) => s.ccOn);
  const pill = useStore((s) => s.pill);
  const [clock, setClock] = useState("--:--");

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer id="bar">
      <div className="bar-left"><span id="clock">{clock}</span><span className="sep">|</span>forge</div>
      <div className="bar-center">
        <button className={"ctl" + (micOn ? "" : " off")} id="btn-mic" title="Toggle microphone" onClick={() => session.toggleMic()}>
          <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
        </button>
        <button className={"ctl" + (camOn ? "" : " off")} id="btn-cam" title="Toggle camera" onClick={() => session.toggleCam()}>
          <svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" /></svg>
        </button>
        <button className={"ctl" + (ccOn ? "" : " dim")} id="btn-cc" title="Toggle captions" onClick={() => session.toggleCC()}>
          <svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z" /></svg>
        </button>
        <button className="ctl" id="btn-chat" title="Ask Forge / transcript" onClick={() => session.togglePanel()}>
          <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" /></svg>
        </button>
        <button className="ctl end" id="btn-end" title="Leave call" onClick={() => session.end()}>
          <svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .4-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.29-.7.29-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" /></svg>
        </button>
      </div>
      <div className="bar-right"><span id="backend-pill" className={pill.cls} title={pill.title}>●</span> 👥 2</div>
    </footer>
  );
}
