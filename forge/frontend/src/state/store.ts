import { create } from "zustand";
import type { ForgeTask, Health, TranscriptLine } from "../types";

// Volume prefs survive reloads. Number(null) is 0, so check presence first.
function storedVolume(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 1;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

export type Phase = "landing" | "prejoin" | "room" | "ended";

/** Forge's meeting stage — the single source of truth for what Forge is doing.
 *  listening → (question) working → ready → presenting/speaking → listening.
 *  "hand" is the passive raise ("I have a thought"); "ready" is a prepared
 *  answer waiting for a polite moment to start. */
export type ForgeStage = "listening" | "working" | "ready" | "presenting" | "speaking" | "hand";

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
  stage: ForgeStage;
  agentStatus: string;
  caption: Caption;
  transcript: TranscriptLine[];
  handRaised: boolean;
  presenting: boolean;
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
  /** active/queued/recently-finished Forge tasks (answers, walkthroughs, issues) */
  tasks: ForgeTask[];
  /** playback volume for Forge's voice (0..1) */
  forgeVolume: number;
  /** playback volume for the remote peer (0..1) */
  peerVolume: number;
  /** code panel state */
  codePanelOpen: boolean;
  codePanelFile: string | null;
  codePanelLines: string[];
  codePanelStartLine: number;
  codePanelHighlight: { start: number; end: number } | null;
  codePanelGithubUrl: string | null;
}

export const useStore = create<ForgeState>()(() => ({
  phase: "landing",
  stage: "listening",
  agentStatus: "listening",
  caption: { speaker: "", text: "", visible: false },
  transcript: [],
  handRaised: false,
  presenting: false,
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
  tasks: [],
  forgeVolume: storedVolume("forge-volume"),
  peerVolume: storedVolume("forge-peer-volume"),
  codePanelOpen: false,
  codePanelFile: null,
  codePanelLines: [],
  codePanelStartLine: 1,
  codePanelHighlight: null,
  codePanelGithubUrl: null,
}));
