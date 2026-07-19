import { useEffect, useState } from "react";
import { session } from "../lib/session";
import { ACCESS_TOKEN } from "../config";
import { useStore } from "../state/store";

export default function ControlBar() {
  const micOn = useStore((s) => s.micOn);
  const camOn = useStore((s) => s.camOn);
  const ccOn = useStore((s) => s.ccOn);
  const pill = useStore((s) => s.pill);
  const remoteName = useStore((s) => s.remoteName);
  const model = useStore((s) => s.model);
  const [clock, setClock] = useState("--:--");
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  const shareInvite = async () => {
    if (!ACCESS_TOKEN) return;
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: "Join my Forge meeting", url });
      else await navigator.clipboard.writeText(url);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      // A cancelled native share sheet is not an error worth surfacing.
    }
  };

  return (
    <footer id="bar">
      <div className="bar-left"><span className="brand">forge<span className="brand-dot">·</span></span><span className="chip" id="clock">{clock}</span></div>
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
        <button
          className={"ctl" + (inviteCopied ? " copied" : "")}
          id="btn-share"
          title={ACCESS_TOKEN ? (inviteCopied ? "Invite link copied" : "Share invite link") : "Open the invite URL with its token to share"}
          aria-label="Share invite link"
          disabled={!ACCESS_TOKEN}
          onClick={() => void shareInvite()}
        >
          {inviteCopied ? (
            <svg viewBox="0 0 24 24"><path d="m9.2 16.2-3.7-3.7 1.4-1.4 2.3 2.3 7.9-7.9 1.4 1.4-9.3 9.3z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.1.9l-7.1-4.1a3.2 3.2 0 0 0 0-1.6l7.1-4.1A3 3 0 1 0 15 5a3.2 3.2 0 0 0 .1.8L8 9.9A3 3 0 1 0 8 14l7.1 4.1A3.2 3.2 0 0 0 15 19a3 3 0 1 0 3-3Zm0-12a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM6 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm12 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" /></svg>
          )}
        </button>
        <button className="ctl end" id="btn-end" title="Leave call" onClick={() => session.end()}>
          <svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .4-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.29-.7.29-.28 0-.53-.11-.71-.29L.29 13.08a.996.996 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" /></svg>
        </button>
      </div>
      <div className="bar-right">
        <button
          className={"model-chip" + (model === "sonnet" ? " sonnet" : "")}
          title={`Brain: ${model === "sonnet" ? "Sonnet (deeper)" : "Haiku (fast)"} — click to switch`}
          onClick={() => session.setModel(model === "haiku" ? "sonnet" : "haiku")}
        >
          {model === "sonnet" ? "S" : "H"}
        </button>
        <span id="backend-pill" className={pill.cls} title={pill.title}>●</span>
        <span className="chip">👥 {remoteName ? 3 : 2}</span>
      </div>
    </footer>
  );
}
