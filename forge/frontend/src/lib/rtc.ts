// RoomLink: connects to the backend's /ws room for (a) WebRTC signaling —
// audio/video then flows browser↔browser, peer-to-peer via STUN — and
// (b) "cast" events that keep Forge state (utterances, steps, hand) in sync
// across both participants.
import { ACCESS_TOKEN, API } from "../config";
import { useStore } from "../state/store";
import type { WhiteboardOp } from "../types";

export type CastEvent =
  | { k: "utter"; who: string; text: string }
  | { k: "agent-start" }
  | { k: "step"; say: string; ops?: WhiteboardOp[] }
  | { k: "agent-end" }
  | { k: "cancel" }
  | { k: "board-clear" }
  | { k: "hand"; raised: boolean; reason: string }
  | { k: "board-edit" }
  | { k: "board-move"; id: string; dx: number; dy: number }
  | { k: "board-sync"; ops: WhiteboardOp[]; moves: Array<{ id: string; dx: number; dy: number }> }
  | { k: "focus"; file: string; startLine: number; endLine: number }
  | { k: "code-panel-open"; file: string; githubUrl?: string };

interface ServerMsg {
  t: "welcome" | "peer-joined" | "peer-left" | "signal" | "cast" | "full";
  id?: number;
  name?: string;
  from?: number;
  peers?: { id: number; name: string }[];
  data?: SignalData;
  event?: CastEvent;
}

interface SignalData {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

export interface RoomCallbacks {
  onCast: (ev: CastEvent) => void;
  onPeerJoined: (name: string) => void;
  onPeerLeft: (name: string) => void;
}

export class RoomLink {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private myId = 0;
  private peerId: number | null = null;
  private peerName = "Guest";
  private localStream: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private cb: RoomCallbacks;

  constructor(cb: RoomCallbacks) {
    this.cb = cb;
  }

  /** The driver (lowest id) runs passive listen checks so only one side auto-raises the hand. */
  get isDriver(): boolean {
    return this.peerId === null || this.myId < this.peerId;
  }

  get hasPeer(): boolean {
    return this.peerId !== null;
  }

  connect(name: string, stream: MediaStream | null): void {
    this.localStream = stream;
    const base = API || window.location.origin;
    const token = ACCESS_TOKEN ? `?token=${encodeURIComponent(ACCESS_TOKEN)}` : "";
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws${token}`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", name }));
    ws.onmessage = (e) => void this.handle(JSON.parse(String(e.data)) as ServerMsg);
  }

  cast(event: CastEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "cast", event }));
  }

  close(): void {
    this.teardownPeer();
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private async handle(msg: ServerMsg): Promise<void> {
    switch (msg.t) {
      case "welcome":
        this.myId = msg.id ?? 0;
        if (msg.peers?.length) {
          // I'm the newcomer; the existing member initiates the offer.
          this.adoptPeer(msg.peers[0].id, msg.peers[0].name);
          await this.setupPeer(false);
        }
        break;
      case "peer-joined":
        this.adoptPeer(msg.id ?? 0, msg.name ?? "Guest");
        await this.setupPeer(true);
        break;
      case "peer-left":
        this.teardownPeer();
        useStore.setState({ remoteName: null, remoteStream: null });
        this.cb.onPeerLeft(this.peerName);
        break;
      case "signal":
        if (msg.data) await this.onSignal(msg.data);
        break;
      case "cast":
        if (msg.event) this.cb.onCast(msg.event);
        break;
      case "full":
        useStore.setState({ prejoinHint: "Room is full — Forge calls are two humans max for now." });
        break;
    }
  }

  private adoptPeer(id: number, name: string): void {
    this.peerId = id;
    this.peerName = name;
    useStore.setState({ remoteName: name });
    this.cb.onPeerJoined(name);
  }

  private async setupPeer(initiator: boolean): Promise<void> {
    this.teardownPeerConnectionOnly();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this.pc = pc;
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    pc.ontrack = (e) => {
      if (e.streams[0]) useStore.setState({ remoteStream: e.streams[0] });
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal({ ice: e.candidate.toJSON() });
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal({ sdp: pc.localDescription ?? undefined });
    }
  }

  private async onSignal(data: SignalData): Promise<void> {
    if (!this.pc) await this.setupPeer(false);
    const pc = this.pc!;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of this.pendingIce) await pc.addIceCandidate(c);
      this.pendingIce = [];
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal({ sdp: pc.localDescription ?? undefined });
      }
    } else if (data.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.ice);
      else this.pendingIce.push(data.ice);
    }
  }

  private signal(data: SignalData): void {
    if (this.peerId !== null && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "signal", to: this.peerId, data }));
    }
  }

  private teardownPeerConnectionOnly(): void {
    try { this.pc?.close(); } catch { /* noop */ }
    this.pc = null;
    this.pendingIce = [];
  }

  private teardownPeer(): void {
    this.teardownPeerConnectionOnly();
    this.peerId = null;
  }
}
