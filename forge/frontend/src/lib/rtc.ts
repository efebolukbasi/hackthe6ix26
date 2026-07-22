// RoomLink: connects to the backend's /ws room for (a) WebRTC signaling —
// audio/video then flows browser↔browser as a full P2P mesh via STUN (one
// RTCPeerConnection per remote peer) — and (b) "cast" events that keep Forge
// state (utterances, steps, hand) in sync across all participants.
import { ACCESS_TOKEN, API, SESSION_ID } from "../config";
import { useStore } from "../state/store";
import type { ForgeTask, WhiteboardOp } from "../types";

/** Repo-stage state carried in a board-sync so a late joiner sees the same file. */
export interface StageSync {
  file: string;
  startLine?: number;
  endLine?: number;
  highlight?: { start: number; end: number };
}

export type CastEvent =
  | { k: "utter"; who: string; text: string }
  | { k: "agent-start"; ack?: string }
  | { k: "trace"; line: string }
  | { k: "agent-ready" }
  | { k: "invite" }
  | { k: "step"; say: string; ops?: WhiteboardOp[] }
  | { k: "agent-end" }
  | { k: "cancel" }
  | { k: "board-clear" }
  | { k: "hand"; raised: boolean; reason: string }
  | { k: "board-edit" }
  | { k: "board-move"; id: string; dx: number; dy: number }
  | { k: "board-sync"; ops: WhiteboardOp[]; moves: Array<{ id: string; dx: number; dy: number }>; stage?: StageSync }
  | { k: "focus"; file: string; startLine: number; endLine: number }
  | { k: "code-panel-open"; file: string; startLine?: number; endLine?: number }
  | { k: "code-panel-close" }
  // Task registry sync: owners upsert their tasks; a peer asks the owner to
  // cancel one via task-cancel (only the owner can actually stop the work).
  | { k: "task"; task: Omit<ForgeTask, "mine"> }
  | { k: "task-cancel"; id: string }
  // Server-originated: the meeting's active repository changed.
  | { k: "repo"; repo: { name?: string; fileCount?: number }; by?: string };

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
  /** isNew: they joined after us (vs. were already here when we arrived). */
  onPeerJoined: (name: string, isNew: boolean) => void;
  onPeerLeft: (name: string) => void;
}

/** One remote human in the mesh: their signaling identity + media link. */
interface PeerLink {
  id: number;
  name: string;
  pc: RTCPeerConnection | null;
  pendingIce: RTCIceCandidateInit[];
  stream: MediaStream | null;
}

export class RoomLink {
  private ws: WebSocket | null = null;
  private myId = 0;
  private peers = new Map<number, PeerLink>();
  private localStream: MediaStream | null = null;
  private cb: RoomCallbacks;
  private myName = "Guest";
  private closedByUs = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(cb: RoomCallbacks) {
    this.cb = cb;
  }

  /** The driver (lowest id in the room) runs passive listen checks and late-
   * joiner board syncs, so exactly one participant does each. */
  get isDriver(): boolean {
    for (const id of this.peers.keys()) if (id < this.myId) return false;
    return true;
  }

  connect(name: string, stream: MediaStream | null): void {
    this.myName = name;
    this.localStream = stream;
    this.open();
  }

  private open(): void {
    const base = API || window.location.origin;
    const token = ACCESS_TOKEN ? `?token=${encodeURIComponent(ACCESS_TOKEN)}` : "";
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws${token}`);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 1000;
      // sid ties room presence to this browser's GitHub sign-in, so the
      // meeting's one-account lock frees up when its holder leaves for good.
      ws.send(JSON.stringify({ t: "join", name: this.myName, sid: SESSION_ID }));
    };
    ws.onmessage = (e) => void this.handle(JSON.parse(String(e.data)) as ServerMsg);
    // Dropped connection (backend restart, proxy idle timeout, flaky wifi):
    // quietly reconnect and re-join so the meeting survives the hiccup.
    ws.onclose = () => {
      if (this.closedByUs || this.ws !== ws) return;
      this.teardownAllPeers();
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
  }

  cast(event: CastEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "cast", event }));
  }

  close(): void {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.teardownAllPeers();
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private async handle(msg: ServerMsg): Promise<void> {
    switch (msg.t) {
      case "welcome":
        this.myId = msg.id ?? 0;
        // I'm the newcomer: each existing member will send me an offer
        // (their peer-joined fires); I just register them and wait.
        for (const p of msg.peers ?? []) {
          this.adoptPeer(p.id, p.name, false);
        }
        break;
      case "peer-joined": {
        // Someone new arrived: I'm the established side, so I initiate.
        const peer = this.adoptPeer(msg.id ?? 0, msg.name ?? "Guest", true);
        await this.setupPeer(peer, true);
        break;
      }
      case "peer-left": {
        const peer = this.peers.get(msg.id ?? -1);
        if (!peer) break;
        this.teardownPeer(peer);
        this.peers.delete(peer.id);
        this.pushPeersToStore();
        this.cb.onPeerLeft(peer.name);
        break;
      }
      case "signal":
        if (msg.data && msg.from != null) await this.onSignal(msg.from, msg.data);
        break;
      case "cast":
        if (msg.event) this.cb.onCast(msg.event);
        break;
      case "full":
        useStore.setState({ prejoinHint: "Room is full — someone has to leave before you can join." });
        break;
    }
  }

  private adoptPeer(id: number, name: string, isNew: boolean): PeerLink {
    const peer: PeerLink = { id, name, pc: null, pendingIce: [], stream: null };
    this.peers.set(id, peer);
    this.pushPeersToStore();
    this.cb.onPeerJoined(name, isNew);
    return peer;
  }

  private pushPeersToStore(): void {
    useStore.setState({
      peers: [...this.peers.values()].map((p) => ({ id: p.id, name: p.name, stream: p.stream })),
    });
  }

  private async setupPeer(peer: PeerLink, initiator: boolean): Promise<void> {
    try { peer.pc?.close(); } catch { /* noop */ }
    peer.pendingIce = [];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    peer.pc = pc;
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    pc.ontrack = (e) => {
      if (e.streams[0]) {
        peer.stream = e.streams[0];
        this.pushPeersToStore();
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peer.id, { ice: e.candidate.toJSON() });
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(peer.id, { sdp: pc.localDescription ?? undefined });
    }
  }

  private async onSignal(from: number, data: SignalData): Promise<void> {
    let peer = this.peers.get(from);
    // Signal from someone we haven't registered (join/welcome race) — adopt
    // them quietly so the call still forms.
    if (!peer) peer = this.adoptPeer(from, "Guest", false);
    if (!peer.pc) await this.setupPeer(peer, false);
    const pc = peer.pc!;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.pendingIce) await pc.addIceCandidate(c);
      peer.pendingIce = [];
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(peer.id, { sdp: pc.localDescription ?? undefined });
      }
    } else if (data.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.ice);
      else peer.pendingIce.push(data.ice);
    }
  }

  private signal(to: number, data: SignalData): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "signal", to, data }));
    }
  }

  private teardownPeer(peer: PeerLink): void {
    try { peer.pc?.close(); } catch { /* noop */ }
    peer.pc = null;
    peer.pendingIce = [];
    peer.stream = null;
  }

  private teardownAllPeers(): void {
    for (const peer of this.peers.values()) this.teardownPeer(peer);
    this.peers.clear();
    this.pushPeersToStore();
  }
}
