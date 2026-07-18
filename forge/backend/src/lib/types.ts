// Shared types for the Forge backend. Mirrors the runtime shapes produced and
// consumed by lib/agent.ts, lib/prompt.ts, lib/repo.ts, and server.ts.

/** Optional source-location attribution for a node or code card op. */
export interface NodeAttr {
  file: string;
  startLine?: number;
  endLine?: number;
}

// The op schema mirrors frontend/whiteboard.js (see lib/prompt.ts OPS_SPEC).
export type WhiteboardOp =
  | { op: "clear" }
  | { op: "title"; text: string }
  | {
      op: "node";
      id: string;
      x: number;
      y: number;
      label: string;
      sub?: string;
      color?: string;
      w?: number;
      h?: number;
      /** Optional attribution to a specific file location in the repo. */
      attr?: NodeAttr;
    }
  | { op: "arrow"; id?: string; from: string; to: string; label?: string; bow?: number }
  | { op: "note"; x: number; y: number; text: string; color?: string }
  | { op: "circle"; target: string; color?: string }
  | { op: "cross"; target: string }
  | { op: "fade"; ids: string[] }
  | {
      op: "code";
      id: string;
      x: number;
      y: number;
      file: string;
      line?: number;
      text?: string;
      color?: string;
      /** Optional attribution to a specific file location in the repo. */
      attr?: NodeAttr;
    };

export interface AgentStep {
  say: string;
  ops: WhiteboardOp[];
}

export interface TranscriptLine {
  who: string;
  text: string;
}

export interface AgentRequestBody {
  question?: string;
  invited?: boolean;
  reason?: string;
  transcript?: TranscriptLine[];
  board?: unknown;
  /** the team cut off an in-progress explanation with this new request */
  interrupted?: boolean;
  /** if true, run in walkthrough mode (focus events) */
  walkthrough?: boolean;
}

export interface WalkthroughRequestBody {
  nodeId: string;
  nodeLabel: string;
  attr: NodeAttr;
  transcript: TranscriptLine[];
  board: unknown;
}

/** Emitted when Claude Code uses a tool (CLI mode only). */
export interface ToolEvent {
  type: 'tool';
  name: string;
  input: string;
}

/** Emitted during a walkthrough to scroll the code panel. */
export interface FocusEvent {
  type: 'focus';
  file: string;
  startLine: number;
  endLine: number;
}

export interface ListenResult {
  raise: boolean;
  reason: string;
}

export interface RepoMeta {
  name: string;
  fileCount: number;
  includedFiles?: number;
  chars?: number;
}
