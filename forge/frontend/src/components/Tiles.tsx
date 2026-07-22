import { useEffect, useRef } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

/** Hover-revealed volume slider pinned to a tile's top-left corner. */
function VolumeControl({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="tile-volume" title={`${label} volume`}>
      {value === 0 ? (
        <svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25a6.9 6.9 0 0 1-2.25 1.2v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4 9.91 6.09 12 8.18V4z" /></svg>
      ) : (
        <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" /></svg>
      )}
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        aria-label={`${label} volume`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** One remote participant's video tile (P2P mesh). All remote tiles share the
 * single "peers" volume setting. */
function PeerTile({ name, stream }: { name: string; stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const peerVolume = useStore((s) => s.peerVolume);

  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = peerVolume;
  }, [peerVolume, stream]);

  return (
    <div className="tile tile-peer">
      <video ref={ref} autoPlay playsInline />
      <div className="nametag">{name}</div>
      <VolumeControl value={peerVolume} onChange={(v) => session.setPeerVolume(v)} label={name} />
    </div>
  );
}

export default function Tiles() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamReady = useStore((s) => s.streamReady);
  const youTalking = useStore((s) => s.youTalking);
  const camOff = useStore((s) => s.camOff);
  const orbSpeaking = useStore((s) => s.orbSpeaking);
  const stage = useStore((s) => s.stage);
  const handRaised = useStore((s) => s.handRaised);
  const agentStatus = useStore((s) => s.agentStatus);
  const peers = useStore((s) => s.peers);
  const myName = useStore((s) => s.myName);
  const listeningActive = useStore((s) => s.listeningActive);
  const forgeVolume = useStore((s) => s.forgeVolume);

  useEffect(() => {
    if (streamReady && videoRef.current) videoRef.current.srcObject = session.stream;
  }, [streamReady]);

  const working = stage === "working";
  const handVisible = handRaised || stage === "ready";
  const orbClass = [
    "orb-wrap",
    working ? "working" : "",
    listeningActive && stage === "listening" && !orbSpeaking ? "listening" : "",
    orbSpeaking ? "speaking" : "",
  ].filter(Boolean).join(" ");

  // Tile sizing scales with the head-count (humans + Forge's tile).
  const total = peers.length + 2;
  const sizeClass = total <= 2 ? "" : total === 3 ? "trio" : total === 4 ? "quad" : total <= 6 ? "hex" : "octo";

  return (
    <div id="tiles" className={sizeClass}>
      <div className={"tile" + (youTalking ? " talking" : "") + (camOff ? " camoff" : "")} id="tile-you">
        <video id="cam" ref={videoRef} autoPlay playsInline muted />
        <div className="avatar">E</div>
        <div className="nametag">{myName || "You"} <span className="you-tag">(you)</span></div>
      </div>
      {peers.map((p) => (
        <PeerTile key={p.id} name={p.name} stream={p.stream} />
      ))}
      <div className="tile agent" id="tile-agent">
        <div className={orbClass}>
          <span className="halo h1" /><span className="halo h2" />
          <div className={"orb" + (orbSpeaking ? " speaking" : "")} id="orb" />
        </div>
        <div className={"thinking" + (working ? "" : " hidden")} id="thinking"><span /><span /><span /></div>
        <button className={"hand" + (handVisible ? "" : " hidden")} id="hand" title="Let Forge speak" onClick={() => session.handClick()}>
          <span className="hand-emoji">✋</span>
          <span className="hand-label">
            {stage === "ready"
              ? <>Forge is ready — <strong>go ahead</strong></>
              : <>Forge has a thought — <strong>invite</strong></>}
          </span>
        </button>
        <div className="nametag">Forge · AI Engineer</div>
        <div className="agent-status" id="agentstatus"><span className="status-dot" />{agentStatus}</div>
        <VolumeControl value={forgeVolume} onChange={(v) => session.setForgeVolume(v)} label="Forge" />
      </div>
    </div>
  );
}
