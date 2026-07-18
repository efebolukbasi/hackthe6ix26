// LLM access layer. Forge uses the Anthropic Messages API exclusively, with a
// local read_file/grep/list_files tool loop over the loaded repository.
import { REPO_TOOL_DEFS, runRepoTool } from "./repoTools.ts";

const API_MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-8",
};

export function llmMode(): "api" {
  return "api";
}

interface StreamTextOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  onDelta?: (chunk: string) => void;
  /** Called when the model uses a tool (name, serialised input). */
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  /** Allow read-only repo tools to run from `cwd`. */
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  return apiStream({ system, prompt, model, maxTokens, onDelta, onTool, signal, tools, cwd });
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
  // answers with text. The final turn
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
