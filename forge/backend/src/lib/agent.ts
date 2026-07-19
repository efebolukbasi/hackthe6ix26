// The Forge brain: turns meeting context into streamed whiteboard steps.
import type { Response } from "express";
import { llmMode, streamText, type ExtraTools } from "./llm.ts";
import { buildSystem, buildUser, buildIssueSystem, buildIssuePrompt, buildListenPrompt, buildWalkthroughSystem, buildWalkthroughUser } from "./prompt.ts";
import * as github from "./github.ts";
import { implementIssue, type PullRequestResult } from "./implement.ts";
import type { AgentRequestBody, AgentStep, ListenResult, TranscriptLine, WhiteboardOp, WalkthroughRequestBody } from "./types.ts";

let REPO_DIGEST = "";
let REPO_CWD: string | undefined;
let REPO_SLUG: string | undefined;
export function setRepoContext(digest: string, repoPath?: string, slug?: string | null): void {
  REPO_CWD = repoPath;
  REPO_SLUG = slug ?? undefined;
  REPO_DIGEST = digest;
}
export function getRepoCwd(): string | undefined {
  return REPO_CWD;
}
export function getRepoSlug(): string | undefined {
  return REPO_SLUG;
}

/** GitHub issue read tools for the meeting/walkthrough agents — lets Forge
 * answer "what issues are open?" against the real tracker. */
function issueTools(): ExtraTools | undefined {
  if (!REPO_CWD) return undefined;
  const cwd = REPO_CWD;
  return {
    defs: [
      {
        name: "list_github_issues",
        description: "List the active repository's GitHub issues (number, title, state). Optional state filter: open (default), closed, or all.",
        input_schema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "all"] } } },
      },
      {
        name: "read_github_issue",
        description: "Read one GitHub issue's title and full body by number.",
        input_schema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] },
      },
    ],
    run: async (name, input) => {
      if (name === "list_github_issues") {
        const state = input.state === "closed" || input.state === "all" ? input.state : "open";
        const issues = await github.listIssues(cwd, REPO_SLUG, state);
        if (!issues.length) return `no ${state} issues`;
        return issues
          .map((i) => `#${i.number} [${i.state}] ${i.title} (updated ${i.updated_at.slice(0, 10)})`)
          .join("\n");
      }
      if (name === "read_github_issue") {
        const issue = await github.getIssue(cwd, Number(input.number), REPO_SLUG);
        return `#${issue.number} [${issue.state}] ${issue.title}\n\n${(issue.body || "(no body)").slice(0, 4000)}`;
      }
      return `error: unknown tool ${name}`;
    },
  };
}

// Claude drafts a GitHub issue from the spoken request, the meeting context,
// and — critically — its own exploration of the repository.
export async function draftIssue(
  command: string,
  transcript: TranscriptLine[],
  onTool?: (name: string, input: string) => void
): Promise<{ title: string; body: string }> {
  const text = await streamText({
    system: buildIssueSystem(REPO_DIGEST),
    prompt: buildIssuePrompt(command, transcript),
    maxTokens: 3500,
    maxTurns: 12,
    tools: true,
    cwd: REPO_CWD,
    onTool,
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

/** NDJSON event writer shared by the long-running GitHub flows. */
function ndjsonWriter(res: Response): { send: (obj: Record<string, unknown>) => void; end: () => void } {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  return {
    send: (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); },
    end: () => { if (!res.writableEnded) res.end(); },
  };
}

/**
 * Streamed issue creation: research progress → the created (or reused) issue.
 * Events: {type:"progress",text} {type:"tool",name,input}
 *         {type:"issue", html_url, number, title, created, duplicate}
 *         {type:"error",message} — always terminated by {type:"done"}.
 */
export async function createIssueFlow(
  body: { command?: string; title?: string; body?: string; transcript?: TranscriptLine[]; idempotencyKey?: string },
  res: Response,
  log: Pick<Console, "error"> = console
): Promise<void> {
  const { send, end } = ndjsonWriter(res);
  try {
    if (!REPO_CWD) throw Object.assign(new Error("no repo loaded"), { status: 400 });
    let title = String(body.title || "").trim();
    let issueBody = String(body.body || "").trim();
    if (body.command) {
      send({ type: "progress", text: "researching the repo before writing the issue" });
      try {
        const draft = await draftIssue(
          String(body.command),
          Array.isArray(body.transcript) ? body.transcript : [],
          (name, input) => send({ type: "tool", name, input: input.slice(0, 120) })
        );
        title = draft.title;
        issueBody = draft.body;
      } catch (err) {
        log.error("issue draft failed, using fallback:", err instanceof Error ? err.message : String(err));
      }
    }
    if (!title) title = "Meeting follow-up";
    if (!issueBody) issueBody = "Created from a Forge meeting.";
    send({ type: "progress", text: "filing the issue on GitHub" });
    const issue = await github.createOrReuseIssue(REPO_CWD, title, issueBody, REPO_SLUG, body.idempotencyKey);
    send({ type: "issue", ...issue });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    send({ type: "done" });
    end();
  }
}

/**
 * Streamed issue implementation: worktree progress → the opened (or reused) PR.
 * Events: {type:"progress",text} {type:"tool",name,input}
 *         {type:"pr", html_url, number, title, branch, created, summary}
 *         {type:"error",message} — always terminated by {type:"done"}.
 */
export async function implementIssueFlow(number: number, res: Response, log: Pick<Console, "error"> = console): Promise<void> {
  const { send, end } = ndjsonWriter(res);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    if (!REPO_CWD) throw Object.assign(new Error("no repo loaded"), { status: 400 });
    const pr: PullRequestResult = await implementIssue(REPO_CWD, number, REPO_DIGEST, REPO_SLUG, {
      onPhase: (text) => send({ type: "progress", text }),
      onTool: (name, input) => send({ type: "tool", name, input: input.slice(0, 120) }),
      signal: abort.signal,
    });
    send({ type: "pr", ...pr });
  } catch (err) {
    log.error("implement flow failed:", err instanceof Error ? err.message : String(err));
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    send({ type: "done" });
    end();
  }
}

const KNOWN_OPS = new Set(["clear", "title", "node", "arrow", "note", "circle", "cross", "fade", "code"]);

/** "say" is spoken aloud and shown as a caption — markdown markers, stray
 * backslashes, code ticks, and leaked JSON/op fragments must never reach
 * either surface. Returns "" when nothing speakable remains (step dropped). */
function cleanSay(text: string): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|\s)[*_#>-]\s+/g, "$1")
    .replace(/\\+/g, " ");
  // A derailed model can nest op JSON inside "say" — scrub the fragments.
  if (/[{}[\]]|"\s*:/.test(s)) {
    s = s
      .replace(/[{}[\]"]+/g, " ")
      .replace(/\b(op|id|from|to|label|say|ops|bow|color|attr|file|line|text|sub|target|ids|x|y|w|h)\s*:\s*/gi, " ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 300) {
    const cut = s.slice(0, 300);
    s = cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), 240) + 1).trim() || cut;
  }
  // If what's left barely resembles language, drop the step entirely.
  const letters = (s.match(/[a-z]/gi) || []).length;
  if (s.length < 2 || letters / Math.max(1, s.length) < 0.55) return "";
  return s;
}

function sanitizeStep(obj: unknown): AgentStep | null {
  const candidate = obj as { say?: unknown; ops?: unknown } | null | undefined;
  if (!candidate || typeof candidate.say !== "string" || !candidate.say.trim()) return null;
  const ops: WhiteboardOp[] = Array.isArray(candidate.ops)
    ? candidate.ops.filter((o: { op?: unknown }) => o && KNOWN_OPS.has(o.op as string))
    : [];
  const say = cleanSay(candidate.say);
  if (!say) return null;
  return { say, ops };
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
    // Built per call: the tool roster differs between the API and CLI brains,
    // and the mode can flip mid-process (API billing failure → CLI fallback).
    const fullText = await streamText({
      system: buildSystem(REPO_DIGEST, !!REPO_CWD, llmMode() === "api"),
      prompt: buildUser({ question, transcript, board, invited, reason, interrupted }),
      onDelta: (t: string) => parser.push(t),
      onTool: (name, input) => send({ type: "tool", name, input }),
      signal: abort.signal,
      tools: true,
      cwd: REPO_CWD,
      extraTools: issueTools(),
    });
    const n = parser.flush();
    if (n === 0) {
      // The model answered in prose instead of NDJSON (common for casual
      // questions) — speak the prose itself rather than apologizing.
      log.error("agent answered in prose, salvaging. First 200 chars:", fullText.slice(0, 200));
      let plain = fullText.replace(/```[\s\S]*?```/g, " ");
      // Strip JSON innermost-first so NESTED braces (ops inside steps) go too;
      // the old single non-greedy pass left fragments that got spoken aloud.
      for (let pass = 0; pass < 8 && /\{[^{}]*\}/.test(plain); pass++) {
        plain = plain.replace(/\{[^{}]*\}/g, " ");
      }
      plain = plain
        .replace(/[{}[\]"]/g, " ")
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
      say: "I hit a snag reaching my brain. Check that the backend has a valid Anthropic API key.",
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
