import { create } from "zustand";
import type { Health, TranscriptLine } from "../types";

export type Phase = "prejoin" | "room" | "ended";

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
  listeningActive: boolean;
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
  /** thinking / tool trace lines shown in SidePanel */
  thinkingTrace: string[];
  /** code panel state */
  codePanelOpen: boolean;
  codePanelFile: string | null;
  codePanelLines: string[];
  codePanelStartLine: number;
  codePanelHighlight: { start: number; end: number } | null;
  codePanelGithubUrl: string | null;
}

export const useStore = create<ForgeState>()(() => ({
  phase: "prejoin",
  agentStatus: "listening",
  caption: { speaker: "", text: "", visible: false },
  transcript: [],
  handRaised: false,
  presenting: false,
  thinking: false,
  orbSpeaking: false,
  youTalking: false,
  listeningActive: false,
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
  thinkingTrace: [],
  codePanelOpen: false,
  codePanelFile: null,
  codePanelLines: [],
  codePanelStartLine: 1,
  codePanelHighlight: null,
  codePanelGithubUrl: null,
}));
