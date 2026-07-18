// Shared types for the Forge frontend.
//
// The backend contract:
//   POST /api/agent  → streamed NDJSON lines {"type":"step","say":string,"ops":WhiteboardOp[]}
//                      terminated by {"type":"done"}
//   GET  /api/health → { ok, llm, tts, repo: { name, ... } }
//   POST /api/listen { transcript: [{who,text}] } → { raise, reason }
//   POST /api/tts    { text } → audio/mpeg (or 503 → browser speechSynthesis fallback)

// ---------- whiteboard ops ----------

export interface ClearOp {
  op: "clear";
}

export interface TitleOp {
  op: "title";
  text: string;
  id?: string;
}

export interface NodeOp {
  op: "node";
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  sub?: string;
  color?: string;
}

export interface ArrowOp {
  op: "arrow";
  from: string;
  to: string;
  id?: string;
  label?: string;
  bow?: number;
}

export interface NoteOp {
  op: "note";
  text: string;
  x: number;
  y: number;
  id?: string;
  color?: string;
}

export interface CircleOp {
  op: "circle";
  target: string;
  id?: string;
  color?: string;
}

export interface CrossOp {
  op: "cross";
  target: string;
  id?: string;
}

export interface FadeOp {
  op: "fade";
  ids: string[];
}

export interface CodeOp {
  op: "code";
  id: string;
  x: number;
  y: number;
  file: string;
  line?: number;
  text?: string;
  color?: string;
}

export type WhiteboardOp =
  | ClearOp
  | TitleOp
  | NodeOp
  | ArrowOp
  | NoteOp
  | CircleOp
  | CrossOp
  | FadeOp
  | CodeOp;

/** Ops that get planned into drawn strokes (clear/fade are handled inline). */
export type DrawableOp = Exclude<WhiteboardOp, ClearOp | FadeOp>;

// ---------- board summary (sent back to the agent) ----------

export interface BoardNodeSummary {
  id: string;
  label: string;
  sub?: string;
  dead?: boolean;
}

export interface BoardArrowSummary {
  from: string;
  to: string;
  id?: string;
  label?: string;
  faded?: boolean;
}

export interface BoardSummary {
  title: string | null;
  nodes: BoardNodeSummary[];
  arrows: BoardArrowSummary[];
}

// ---------- agent stream ----------

export interface AgentStep {
  type: "step";
  say: string;
  ops?: WhiteboardOp[];
}

export type StreamMsg = AgentStep | { type: "done" };

// ---------- transcript / health ----------

export interface TranscriptLine {
  who: string;
  text: string;
}

export interface Health {
  ok: boolean;
  llm: string;
  tts: boolean;
  repo?: { name?: string; [key: string]: unknown };
}

// ---------- Web Speech recognition (not in lib.dom) ----------

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

// ---------- globals ----------

declare global {
  interface Window {
    /** Optional backend origin override (split deploys). Empty/unset = same origin. */
    FORGE_API?: string;
    /** Demo/debug hook: feed an utterance as if it were heard through the mic. */
    forge?: { hear: (text: string) => void };
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}
