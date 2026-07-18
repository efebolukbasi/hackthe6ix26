// The Forge brain: turns meeting context into streamed whiteboard steps.
import type { Response } from "express";
import { streamText } from "./llm.ts";
import { buildSystem, buildUser, buildIssuePrompt, buildListenPrompt, buildWalkthroughSystem, buildWalkthroughUser } from "./prompt.ts";
import type { AgentRequestBody, AgentStep, ListenResult, TranscriptLine, WhiteboardOp, WalkthroughRequestBody } from "./types.ts";

let SYSTEM = "";
let REPO_DIGEST = "";
let REPO_CWD: string | undefined;
export function setRepoContext(digest: string, repoPath?: string): void {
  REPO_CWD = repoPath;
  REPO_DIGEST = digest;
  // Both brain paths have live repo tools now (CLI: Read/Grep/Glob; API:
  // read_file/grep/list_files executed locally by llm.ts).
  SYSTEM = buildSystem(digest, !!repoPath);
}
export function getRepoCwd(): string | undefined {
  return REPO_CWD;
}

// Claude drafts a GitHub issue from the spoken request and meeting context.
export async function draftIssue(command: string, transcript: TranscriptLine[]): Promise<{ title: string; body: string }> {
  const text = await streamText({
    system: "You write clear, actionable GitHub issues for an engineering team.",
    prompt: buildIssuePrompt(command, transcript),
    model: process.env.FORGE_MODEL || "sonnet",
    maxTokens: 800,
  });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("issue draft returned no JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as { title?: unknown; body?: unknown };
  const title = String(parsed.title || "").trim();
  if (!title) throw new Error("issue draft missing title");
  return {
    title: title.slice(0, 180),
    body: String(parsed.body || "").trim() || "Created from a Forge meeting.",
  };
}

const KNOWN_OPS = new Set(["clear", "title", "node", "arrow", "note", "circle", "cross", "fade", "code"]);

function sanitizeStep(obj: unknown): AgentStep | null {
  const candidate = obj as { say?: unknown; ops?: unknown } | null | undefined;
  if (!candidate || typeof candidate.say !== "string" || !candidate.say.trim()) return null;
  const ops: WhiteboardOp[] = Array.isArray(candidate.ops)
    ? candidate.ops.filter((o: { op?: unknown }) => o && KNOWN_OPS.has(o.op as string))
    : [];
  return { say: candidate.say.trim(), ops };
}

// Pulls complete JSON lines out of accumulated streamed text, also extracting
// an optional top-level "focus" field for walkthrough mode.
function makeLineParser(
  onStep: (step: AgentStep) => void,
  onFocus?: (file: string, startLine: number, endLine: number) => void
) {
  let buf = "";
  let emitted = 0;
  const tryLine = (line: string) => {
    const trimmed = line
      .trim()
      .replace(/^```(json)?/, "")
      .replace(/```$/, "")
      .trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    try {
      const raw = JSON.parse(trimmed) as {
        say?: unknown;
        ops?: unknown;
        focus?: { file?: unknown; startLine?: unknown; endLine?: unknown };
      };
      const step = sanitizeStep(raw);
      if (step) {
        emitted++;
        // Emit focus event before the step if walkthrough handler present.
        if (onFocus && raw.focus && typeof raw.focus.file === 'string' && typeof raw.focus.startLine === 'number') {
          const endLine = typeof raw.focus.endLine === 'number' ? raw.focus.endLine : raw.focus.startLine;
          onFocus(raw.focus.file, raw.focus.startLine, endLine);
        }
        onStep(step);
      }
    } catch {
      /* incomplete or junk line */
    }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) tryLine(line);
    },
    flush() {
      tryLine(buf);
      buf = "";
      return emitted;
    },
  };
}

// Streams NDJSON steps to the HTTP response as they parse out of the LLM stream.
export async function respond(
  body: AgentRequestBody | undefined,
  res: Response,
  log: Pick<Console, "error"> = console
): Promise<void> {
  const { question = "", transcript = [], board = null, invited = false, reason = "", interrupted = false } = body || {};
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const send = (obj: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };
  const parser = makeLineParser((step) => send({ type: "step", ...step }));

  try {
    const fullText = await streamText({
      system: SYSTEM,
      prompt: buildUser({ question, transcript, board, invited, reason, interrupted }),
      model: process.env.FORGE_MODEL || "sonnet",
      onDelta: (t: string) => parser.push(t),
      onTool: (name, input) => send({ type: "tool", name, input }),
      signal: abort.signal,
      tools: true,
      cwd: REPO_CWD,
    });
    const n = parser.flush();
    if (n === 0) {
      // The model answered in prose instead of NDJSON (common for casual
      // questions) — speak the prose itself rather than apologizing.
      const plain = fullText
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\{[\s\S]*?\}/g, " ")
        .replace(/[*_#`>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (plain) {
        const sentences = plain.match(/[^.!?]+[.!?]+["']?|\S[^.!?]*$/g) ?? [plain];
        let chunk = "";
        const chunks: string[] = [];
        for (const s of sentences) {
          if (chunk && chunk.length + s.length > 240) { chunks.push(chunk.trim()); chunk = ""; }
          chunk += s;
          if (chunks.length === 2) break;
        }
        if (chunk.trim() && chunks.length < 3) chunks.push(chunk.trim());
        for (const c of chunks) send({ type: "step", say: c, ops: [] });
      } else {
        send({ type: "step", say: "Sorry — my thoughts got scrambled on that one. Ask me again?", ops: [] });
      }
    }
    send({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("agent respond failed:", message);
    send({ type: "error", message });
    send({
      type: "step",
      say: "I hit a snag reaching my brain. Check that the backend can reach Claude — either an API key or a Claude Code login.",
      ops: [],
    });
    send({ type: "done" });
  } finally {
    res.end();
  }
}

// Streams a code walkthrough with focus events syncing the code panel.
export async function walkthrough(
  body: WalkthroughRequestBody,
  res: Response,
  log: Pick<Console, "error"> = console
): Promise<void> {
  const { nodeLabel, attr, transcript = [], board = null } = body;
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const send = (obj: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  const parser = makeLineParser(
    (step) => send({ type: "step", ...step }),
    (file, startLine, endLine) => send({ type: "focus", file, startLine, endLine })
  );

  try {
    const walkthroughSystem = buildWalkthroughSystem(REPO_DIGEST, !!REPO_CWD);
    await streamText({
      system: walkthroughSystem,
      prompt: buildWalkthroughUser(nodeLabel, attr, transcript, board),
      model: process.env.FORGE_MODEL || "sonnet",
      onDelta: (t: string) => parser.push(t),
      onTool: (name, input) => send({ type: "tool", name, input }),
      signal: abort.signal,
      tools: true,
      cwd: REPO_CWD,
    });
    const n = parser.flush();
    if (n === 0) {
      send({ type: "step", say: "I couldn't find enough information to walk through this component.", ops: [] });
    }
    send({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("walkthrough failed:", message);
    send({ type: "error", message });
    send({ type: "done" });
  } finally {
    res.end();
  }
}

// Lightweight "should I raise my hand?" check over passively heard transcript.
export async function listen(
  body: AgentRequestBody | undefined,
  log: Pick<Console, "error"> = console
): Promise<ListenResult> {
  const { transcript = [] } = body || {};
  if (!transcript.length) return { raise: false, reason: "" };
  try {
    const text = await streamText({
      system: "You are a concise meeting-assistant classifier.",
      prompt: buildListenPrompt(transcript),
      model: process.env.FORGE_LISTEN_MODEL || "haiku",
      maxTokens: 200,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { raise: false, reason: "" };
    const parsed = JSON.parse(m[0]);
    return { raise: !!parsed.raise, reason: String(parsed.reason || "") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listen check failed:", message);
    return { raise: false, reason: "" };
  }
}
