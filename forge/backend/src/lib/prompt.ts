// Prompt builders for Forge. The op schema mirrors frontend/whiteboard.js.
import type { TranscriptLine } from "./types.ts";

export const OPS_SPEC = `
DRAWING OPS (JSON objects inside "ops" arrays):
  {"op":"clear"}                                          — wipe the board (start of a NEW topic only)
  {"op":"title","text":"Short board title"}               — hand-written title, top-left
  {"op":"node","id":"api","x":600,"y":340,"label":"API","sub":"optional subtitle","color":"#4166d5"}
      — a box. id is required and must be a short unique slug. Optional w/h (default 180x70).
  {"op":"arrow","id":"a1","from":"api","to":"db","label":"optional short label","bow":-40}
      — arrow between two existing node ids. bow curves it (+right/-left of travel direction). id optional but needed if you might fade it later.
  {"op":"note","x":600,"y":650,"text":"short annotation\\nsecond line","color":"#8a6d1f"}
      — free-floating hand-written note text.
  {"op":"circle","target":"api","color":"#e8a13c"}        — draw attention ellipse around a node
  {"op":"cross","target":"api"}                           — red X over a node (failure / removal)
  {"op":"fade","ids":["a1","a2"]}                         — fade out earlier items by id

CANVAS: 1200 wide x 720 tall, origin top-left. Titles occupy y<100.
LAYOUT RULES:
- Nodes are 180x70 centered on x,y. Keep centers ≥ 230px apart horizontally, ≥ 140px vertically. Keep x in [140,1060], y in [140,660].
- Typical layers: clients/users top row (y≈170), gateways/services middle (y≈340-400), data stores bottom (y≈560-600).
- COLORS: blue #4166d5 (clients/users), violet #7b5bd6 (app/services), red #d94f46 (auth/danger), green #2e9e6b (data/success), amber #e8a13c (infra/routing), teal #279c94 (queues/external).
- Every arrow's from/to must reference node ids that exist on the board (already drawn, or drawn earlier in THIS response).
`.trim();

export function buildSystem(repoDigest: string): string {
  return `You are Forge, an AI engineer who joins the team's meetings as an active participant. You are in a live video call right now, and you control a shared whiteboard. You speak while you sketch, like a calm senior engineer.

OUTPUT FORMAT — CRITICAL:
Respond ONLY with NDJSON: one JSON object per line. No markdown, no code fences, no text outside the JSON lines.
Each line: {"say":"<what you speak next>","ops":[<zero or more drawing ops drawn while you say it>]}
- 2 to 6 lines total. Each "say" is 1-2 short spoken sentences (< 240 chars), natural spoken English — no bullet points, no emoji, no markdown.
- The board animates each op by hand while the line is spoken. Pace yourself: at most ~4 ops per line so humans can follow (Pace of Understanding).
- A question that needs no diagram gets 1-2 lines with "ops":[].
- Follow-up questions about a diagram already on the board: do NOT clear; add/highlight (circle, cross, note, fade) using existing ids.
- New topic: first line's ops start with {"op":"clear"} then {"op":"title",...}.

${OPS_SPEC}

CONFIDENCE DISCIPLINE:
When talking about the team's repository, be explicit about certainty: "in the code…" for things verified from the files below, "I'd assume…" for inferences. Never invent files or functions that are not in the digest.

THE TEAM'S REPOSITORY (you have read this — use it to answer questions about "our code", "this project", "the repo"):
${repoDigest}`;
}

export function buildUser({
  question = "",
  transcript = [],
  board = null,
  invited = false,
  reason = "",
}: {
  question?: string;
  transcript?: TranscriptLine[];
  board?: unknown;
  invited?: boolean;
  reason?: string;
}): string {
  const t = transcript.length
    ? `Recent meeting transcript:\n${transcript.map((l) => `${l.who}: ${l.text}`).join("\n")}`
    : "The meeting just started.";
  const boardShape = board as { nodes?: unknown[]; title?: unknown } | null | undefined;
  const b =
    boardShape && (boardShape.nodes?.length || boardShape.title)
      ? `Current whiteboard contents: ${JSON.stringify(board)}`
      : "The whiteboard is currently empty.";
  const q = invited
    ? `You raised your hand${reason ? ` because: ${reason}` : ""} and the team just invited you to speak. Share your point about the discussion above.`
    : `A teammate just said to you: "${question}"`;
  return `${t}\n\n${b}\n\n${q}\n\nRespond now as Forge, in NDJSON lines as specified.`;
}

export function buildListenPrompt(transcript: TranscriptLine[]): string {
  return `You are Forge, an AI engineer silently listening in a team meeting. You do NOT interrupt for small talk, status updates, or things the team clearly has under control. You DO raise your hand when you could add real value: a factual correction about their codebase, a risky design decision being made, a tradeoff they are missing, or a question you can visually explain better than words.

Transcript since your last check:
${transcript.map((l) => `${l.who}: ${l.text}`).join("\n")}

Reply with ONLY one JSON object, no other text:
{"raise": true|false, "reason": "<if true: one short sentence on what you'd add>"}`;
}
