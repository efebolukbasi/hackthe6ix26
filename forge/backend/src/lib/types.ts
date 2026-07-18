// Shared types for the Forge backend. Mirrors the runtime shapes produced and
// consumed by lib/agent.ts, lib/prompt.ts, lib/repo.ts, and server.ts.

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
    }
  | { op: "arrow"; id?: string; from: string; to: string; label?: string; bow?: number }
  | { op: "note"; x: number; y: number; text: string; color?: string }
  | { op: "circle"; target: string; color?: string }
  | { op: "cross"; target: string }
  | { op: "fade"; ids: string[] };

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
