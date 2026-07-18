// The Forge brain: turns meeting context into streamed whiteboard steps.
import { streamText } from "./llm.js";
import { buildSystem, buildUser, buildListenPrompt } from "./prompt.js";

let SYSTEM = "";
export function setRepoDigest(digest) {
  SYSTEM = buildSystem(digest);
}

const KNOWN_OPS = new Set(["clear", "title", "node", "arrow", "note", "circle", "cross", "fade"]);

function sanitizeStep(obj) {
  if (!obj || typeof obj.say !== "string" || !obj.say.trim()) return null;
  const ops = Array.isArray(obj.ops) ? obj.ops.filter((o) => o && KNOWN_OPS.has(o.op)) : [];
  return { say: obj.say.trim(), ops };
}

// Pulls complete JSON lines out of accumulated streamed text.
function makeLineParser(onStep) {
  let buf = "";
  let emitted = 0;
  const tryLine = (line) => {
    const trimmed = line.trim().replace(/^```(json)?/, "").replace(/```$/, "").trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    try {
      const step = sanitizeStep(JSON.parse(trimmed));
      if (step) { emitted++; onStep(step); }
    } catch { /* incomplete or junk line */ }
  };
  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) tryLine(line);
    },
    flush() { tryLine(buf); buf = ""; return emitted; },
  };
}

// Streams NDJSON steps to the HTTP response as they parse out of the LLM stream.
export async function respond(body, res, log = console) {
  const { question = "", transcript = [], board = null, invited = false, reason = "" } = body || {};
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
  const parser = makeLineParser((step) => send({ type: "step", ...step }));

  try {
    await streamText({
      system: SYSTEM,
      prompt: buildUser({ question, transcript, board, invited, reason }),
      model: process.env.FORGE_MODEL || "sonnet",
      onDelta: (t) => parser.push(t),
      signal: abort.signal,
    });
    const n = parser.flush();
    if (n === 0) send({ type: "step", say: "Sorry — my thoughts got scrambled on that one. Ask me again?", ops: [] });
    send({ type: "done" });
  } catch (err) {
    log.error("agent respond failed:", err.message);
    send({ type: "error", message: err.message });
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

// Lightweight "should I raise my hand?" check over passively heard transcript.
export async function listen(body, log = console) {
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
    log.error("listen check failed:", err.message);
    return { raise: false, reason: "" };
  }
}
