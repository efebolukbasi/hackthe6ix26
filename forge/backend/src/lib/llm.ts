// LLM access layer. Two paths:
//  1. ANTHROPIC_API_KEY set  → direct streaming call to the Anthropic API.
//  2. no key                 → headless `claude -p` (Claude Code CLI login),
//     preferring stream-json partial output, falling back to plain text.
import { spawn } from "node:child_process";

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
  signal?: AbortSignal;
}

// Streams text; calls onDelta(chunk) as text arrives. Resolves with full text.
export async function streamText({
  system,
  prompt,
  model = "sonnet",
  maxTokens = 4000,
  onDelta = () => {},
  signal,
}: StreamTextOptions): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return apiStream({ system, prompt, model, maxTokens, onDelta, signal });
  }
  try {
    return await cliStream({ system, prompt, model, onDelta, signal, streamJson: true });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Older CLI without --include-partial-messages, or stream parse trouble.
    return cliStream({ system, prompt, model, onDelta, signal, streamJson: false });
  }
}

interface ApiStreamOptions {
  system: string;
  prompt: string;
  model: string;
  maxTokens: number;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}

async function apiStream({ system, prompt, model, maxTokens, onDelta, signal }: ApiStreamOptions): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: API_MODELS[model] || model,
      max_tokens: maxTokens,
      stream: true,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let full = "";
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
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          full += ev.delta.text;
          onDelta(ev.delta.text);
        }
      } catch {
        /* keep-alive lines etc. */
      }
    }
  }
  return full;
}

interface CliStreamOptions {
  system: string;
  prompt: string;
  model: string;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
  streamJson: boolean;
}

function cliStream({ system, prompt, model, onDelta, signal, streamJson }: CliStreamOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--model", model, "--max-turns", "1"];
    if (streamJson) args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");

    const child = spawn("claude", args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin!.write(`${system}\n\n${prompt}`);
    child.stdin!.end();

    let full = "";
    let sawDelta = false;
    let plain = "";
    let lineBuf = "";
    let stderr = "";

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
