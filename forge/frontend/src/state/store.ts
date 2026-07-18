import { create } from "zustand";
import type { Health, TranscriptLine } from "../types";

export type Phase = "landing" | "prejoin" | "room" | "ended";

export interface Caption {
  speaker: string;
  text: string;
  visible: boolean;
}

export interface BackendPill {
  cls: "" | "ok" | "err";
  title: string;
}

export interface ForgeState {
  phase: Phase;
  agentStatus: string;
  caption: Caption;
  transcript: TranscriptLine[];
  handRaised: boolean;
  presenting: boolean;
  thinking: boolean;
  orbSpeaking: boolean;
  youTalking: boolean;
  health: Health;
  pill: BackendPill;
  ccOn: boolean;
  micOn: boolean;
  camOn: boolean;
  /** you-tile shows the avatar placeholder (cam disabled or blocked at boot) */
  camOff: boolean;
  panelOpen: boolean;
  streamReady: boolean;
  prejoinHint: string;
  /** display name entered on the pre-join screen */
  myName: string;
  /** connected human peer (P2P call), if any */
  remoteName: string | null;
  remoteStream: MediaStream | null;
}

export const useStore = create<ForgeState>()(() => ({
  phase: "landing",
  agentStatus: "listening",
  caption: { speaker: "", text: "", visible: false },
  transcript: [],
  handRaised: false,
  presenting: false,
  thinking: false,
  orbSpeaking: false,
  youTalking: false,
  health: { ok: false, tts: false, llm: "?", repo: { name: "your repo" } },
  pill: { cls: "", title: "backend status" },
  ccOn: true,
  micOn: true,
  camOn: true,
  camOff: false,
  panelOpen: false,
  streamReady: false,
  prejoinHint: "use Chrome · allow camera & microphone",
  myName: "",
  remoteName: null,
  remoteStream: null,
}));
