// LLM access layer. Two paths:
//  1. ANTHROPIC_API_KEY set  → direct streaming call to the Anthropic API,
//     with a local read_file/grep/list_files tool loop over the loaded repo.
//  2. no key                 → headless `claude -p` (Claude Code CLI login),
//     preferring stream-json partial output, falling back to plain text.
// Both paths report tool activity through onTool so the UI can show it.
import { spawn } from "node:child_process";
import { REPO_TOOL_DEFS, runRepoTool } from "./repoTools.ts";

const API_MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-8",
};

export function llmMode(): "api" | "cli" {
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

interface StreamTextOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  onDelta?: (chunk: string) => void;
  /** Called when the model uses a tool (name, serialised input) — both modes. */
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  /** Allow read-only repo tools run from `cwd` (Read/Grep/Glob on the CLI
   * path; read_file/grep/list_files on the API path). */
  tools?: boolean;
  cwd?: string;
}

// Streams text; calls onDelta(chunk) as text arrives. Resolves with full text.
export async function streamText({
  system,
  prompt,
  model = "sonnet",
  maxTokens = 4000,
  onDelta = () => {},
  onTool,
  signal,
  tools = false,
  cwd,
}: StreamTextOptions): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return apiStream({ system, prompt, model, maxTokens, onDelta, onTool, signal, tools, cwd });
  }
  try {
    return await cliStream({ system, prompt, model, onDelta, onTool, signal, streamJson: true, tools, cwd });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Older CLI without --include-partial-messages, or stream parse trouble.
    return cliStream({ system, prompt, model, onDelta, onTool, signal, streamJson: false, tools, cwd });
  }
}

interface ApiStreamOptions {
  system: string;
  prompt: string;
  model: string;
  maxTokens: number;
  onDelta: (chunk: string) => void;
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  tools?: boolean;
  cwd?: string;
}

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ContentBlock = TextBlock | ToolUseBlock;

/** One streamed assistant turn: text deltas go to onDelta as they arrive;
 * tool_use blocks are assembled from input_json_delta events. */
async function apiTurn(
  body: Record<string, unknown>,
  onDelta: (chunk: string) => void,
  onTool: ((name: string, input: string) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<{ blocks: ContentBlock[]; stopReason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const blocks = new Map<number, ContentBlock>();
  const partialJson = new Map<number, string>();
  let stopReason = "";
  let buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === "content_block_start") {
          const cb = ev.content_block;
          if (cb?.type === "tool_use") {
            blocks.set(ev.index, { type: "tool_use", id: String(cb.id), name: String(cb.name), input: {} });
            partialJson.set(ev.index, "");
          } else if (cb?.type === "text") {
            blocks.set(ev.index, { type: "text", text: "" });
          }
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") {
            const block = blocks.get(ev.index);
            if (block?.type === "text") block.text += ev.delta.text;
            onDelta(ev.delta.text);
          } else if (ev.delta?.type === "input_json_delta") {
            partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + ev.delta.partial_json);
          }
        } else if (ev.type === "content_block_stop") {
          const block = blocks.get(ev.index);
          if (block?.type === "tool_use") {
            const raw = partialJson.get(ev.index) ?? "";
            try { block.input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { block.input = {}; }
            onTool?.(block.name, JSON.stringify(block.input));
          }
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          stopReason = String(ev.delta.stop_reason);
        }
      } catch {
        /* keep-alive lines etc. */
      }
    }
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  return { blocks: ordered, stopReason };
}

async function apiStream({ system, prompt, model, maxTokens, onDelta, onTool, signal, tools, cwd }: ApiStreamOptions): Promise<string> {
  const toolsOn = !!(tools && cwd);
  const messages: unknown[] = [{ role: "user", content: prompt }];
  let full = "";
  // Tool loop: run repo tools locally and hand results back until the model
  // answers with text (mirrors the CLI path's --max-turns 8). The final turn
  // disables tool use so exploration can't eat the whole budget and leave the
  // meeting without a spoken answer.
  const MAX_TURNS = 8;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const lastTurn = turn === MAX_TURNS - 1;
    const { blocks, stopReason } = await apiTurn(
      {
        model: API_MODELS[model] || model,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages,
        ...(toolsOn ? { tools: REPO_TOOL_DEFS } : {}),
        ...(toolsOn && lastTurn ? { tool_choice: { type: "none" } } : {}),
      },
      (t) => { full += t; onDelta(t); },
      onTool,
      signal
    );
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (!toolsOn || stopReason !== "tool_use" || toolUses.length === 0) return full;
    messages.push({ role: "assistant", content: blocks });
    messages.push({
      role: "user",
      content: toolUses.map((t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: runRepoTool(cwd!, t.name, t.input),
      })),
    });
  }
  return full;
}

interface CliStreamOptions {
  system: string;
  prompt: string;
  model: string;
  onDelta: (chunk: string) => void;
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  streamJson: boolean;
  tools?: boolean;
  cwd?: string;
}

function cliStream({ system, prompt, model, onDelta, onTool, signal, streamJson, tools, cwd }: CliStreamOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--model", model];
    // With tools on, Claude can grep/read the target repo live before answering.
    if (tools && cwd) args.push("--max-turns", "8", "--allowedTools", "Read,Grep,Glob");
    else args.push("--max-turns", "1");
    if (streamJson) args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");

    const child = spawn("claude", args, {
      cwd: (tools && cwd) || process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => child.kill("SIGKILL"), tools ? 180_000 : 120_000);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin!.write(`${system}\n\n${prompt}`);
    child.stdin!.end();

    let full = "";
    let sawDelta = false;
    let plain = "";
    let lineBuf = "";
    let stderr = "";
    // Tool inputs stream in as input_json_delta — accumulate and report the
    // complete input at block stop, so the UI shows "grep {pattern: …}"
    // rather than an empty "{}".
    const pendingTools = new Map<number, { name: string; json: string }>();

    child.stdout!.on("data", (d: Buffer) => {
      const text = d.toString();
      if (!streamJson) {
        plain += text;
        onDelta(text);
        return;
      }
      lineBuf += text;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "stream_event") {
            const ev = msg.event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              sawDelta = true;
              full += ev.delta.text;
              onDelta(ev.delta.text);
            } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
              pendingTools.set(ev.index, { name: String(ev.content_block.name || ""), json: "" });
            } else if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
              const pending = pendingTools.get(ev.index);
              if (pending) pending.json += String(ev.delta.partial_json ?? "");
            } else if (ev?.type === "content_block_stop") {
              const pending = pendingTools.get(ev.index);
              if (pending) {
                pendingTools.delete(ev.index);
                onTool?.(pending.name, pending.json || "{}");
              }
            }
          } else if (msg.type === "result" && typeof msg.result === "string" && !sawDelta) {
            full = msg.result;
          }
        } catch {
          /* non-JSON noise */
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      if (!streamJson) {
        if (code !== 0 && !plain.trim()) return reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 300)}`));
        return resolve(plain);
      }
      if (!full.trim()) {
        return reject(new Error(`claude CLI (stream-json) produced no text (exit ${code}): ${stderr.slice(0, 300)}`));
      }
      // Only `result` arrived (no partial deltas) — emit it once now.
      if (!sawDelta) onDelta(full);
      resolve(full);
    });
  });
}
