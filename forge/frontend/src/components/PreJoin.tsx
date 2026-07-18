import { useEffect, useRef, useState } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

export default function PreJoin() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamReady = useStore((s) => s.streamReady);
  const hint = useStore((s) => s.prejoinHint);
  const [name, setName] = useState("");

  useEffect(() => {
    void session.boot();
  }, []);

  useEffect(() => {
    if (streamReady && videoRef.current) videoRef.current.srcObject = session.stream;
  }, [streamReady]);

  return (
    <div id="prejoin">
      <div className="prejoin-card">
        <div className="logo">forge<span>·</span></div>
        <div className="preview-wrap">
          <video id="preview" ref={videoRef} autoPlay playsInline muted />
          <div className="preview-tag">You</div>
        </div>
        <p className="prejoin-note"><span className="dot" /> <strong>Forge</strong>, your AI engineering teammate, is already in the call</p>
        <div className="join-group">
          <input
            className="name-input"
            placeholder="Your name"
            maxLength={24}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void session.join(name); }}
          />
          <button id="joinbtn" onClick={() => void session.join(name)}>Join now</button>
        </div>
        <p className="prejoin-hint">{hint}</p>
      </div>
    </div>
  );
}
