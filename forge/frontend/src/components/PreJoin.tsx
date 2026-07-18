import { useEffect, useRef, useState } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

export default function PreJoin() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamReady = useStore((s) => s.streamReady);
  const hint = useStore((s) => s.prejoinHint);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");

  useEffect(() => {
    void session.boot();
  }, []);

  useEffect(() => {
    if (streamReady && videoRef.current) videoRef.current.srcObject = session.stream;
  }, [streamReady]);

  const handleJoin = () => {
    if (!name.trim()) { setNameError("Please enter your name"); return; }
    setNameError("");
    void session.join(name);
  };

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
            className={"name-input" + (nameError ? " input-error" : "")}
            placeholder="Your name"
            maxLength={24}
            value={name}
            onChange={(e) => { setName(e.target.value); if (nameError) setNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleJoin(); }}
          />
          <button id="joinbtn" onClick={handleJoin}>Join now</button>
        </div>
        {nameError && <p className="name-error">{nameError}</p>}
        <p className="prejoin-hint">{hint}</p>
      </div>
    </div>
  );
}
