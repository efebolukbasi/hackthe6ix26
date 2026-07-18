import { useEffect, useRef } from "react";
import { session } from "../lib/session";
import { useStore } from "../state/store";

export default function Tiles() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamReady = useStore((s) => s.streamReady);
  const youTalking = useStore((s) => s.youTalking);
  const camOff = useStore((s) => s.camOff);
  const orbSpeaking = useStore((s) => s.orbSpeaking);
  const thinking = useStore((s) => s.thinking);
  const handRaised = useStore((s) => s.handRaised);
  const agentStatus = useStore((s) => s.agentStatus);

  useEffect(() => {
    if (streamReady && videoRef.current) videoRef.current.srcObject = session.stream;
  }, [streamReady]);

  return (
    <div id="tiles">
      <div className={"tile" + (youTalking ? " talking" : "") + (camOff ? " camoff" : "")} id="tile-you">
        <video id="cam" ref={videoRef} autoPlay playsInline muted />
        <div className="avatar">E</div>
        <div className="nametag">You</div>
      </div>
      <div className="tile agent" id="tile-agent">
        <div className={"orb" + (orbSpeaking ? " speaking" : "")} id="orb" />
        <div className={"thinking" + (thinking ? "" : " hidden")} id="thinking"><span /><span /><span /></div>
        <button className={"hand" + (handRaised ? "" : " hidden")} id="hand" title="Let Forge speak" onClick={() => session.handClick()}>✋</button>
        <div className="nametag">Forge · AI Engineer</div>
        <div className="agent-status" id="agentstatus">{agentStatus}</div>
      </div>
    </div>
  );
}
