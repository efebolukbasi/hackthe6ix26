import { useEffect, useRef } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

export default function Tiles() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<HTMLVideoElement>(null);
  const streamReady = useStore((s) => s.streamReady);
  const youTalking = useStore((s) => s.youTalking);
  const camOff = useStore((s) => s.camOff);
  const orbSpeaking = useStore((s) => s.orbSpeaking);
  const stage = useStore((s) => s.stage);
  const handRaised = useStore((s) => s.handRaised);
  const agentStatus = useStore((s) => s.agentStatus);
  const remoteName = useStore((s) => s.remoteName);
  const remoteStream = useStore((s) => s.remoteStream);
  const myName = useStore((s) => s.myName);
  const listeningActive = useStore((s) => s.listeningActive);
  const thinkingTrace = useStore((s) => s.thinkingTrace);

  useEffect(() => {
    if (streamReady && videoRef.current) videoRef.current.srcObject = session.stream;
  }, [streamReady]);

  useEffect(() => {
    if (peerRef.current && remoteStream) peerRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const working = stage === "working";
  const handVisible = handRaised || stage === "ready";
  const activity = working && thinkingTrace.length > 0 ? thinkingTrace[thinkingTrace.length - 1] : "";
  const orbClass = [
    "orb-wrap",
    working ? "working" : "",
    listeningActive && stage === "listening" && !orbSpeaking ? "listening" : "",
    orbSpeaking ? "speaking" : "",
  ].filter(Boolean).join(" ");

  return (
    <div id="tiles" className={remoteName ? "trio" : ""}>
      <div className={"tile" + (youTalking ? " talking" : "") + (camOff ? " camoff" : "")} id="tile-you">
        <video id="cam" ref={videoRef} autoPlay playsInline muted />
        <div className="avatar">E</div>
        <div className="nametag">{myName || "You"} <span className="you-tag">(you)</span></div>
      </div>
      {remoteName && (
        <div className="tile" id="tile-peer">
          <video id="peercam" ref={peerRef} autoPlay playsInline />
          <div className="nametag">{remoteName}</div>
        </div>
      )}
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
        {activity && <div className="agent-activity" title={activity}>{activity}</div>}
      </div>
    </div>
  );
}
