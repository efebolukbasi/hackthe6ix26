// LLM access layer. Two brain paths:
//  1. ANTHROPIC_API_KEY set → direct streaming Anthropic API with a local
//     read_file/grep/list_files tool loop, plus optional caller-supplied
//     async tools (e.g. GitHub issue reads).
//  2. no key, or the API rejects for billing/auth → headless `claude -p`
//     (Claude Code CLI login) with equivalent read-only repo tools. The
//     fallback is sticky per-process so a dead key doesn't tax every call.
// A separate, narrowly-jailed coding agent edits an isolated git worktree
// when Forge implements a GitHub issue (both paths).
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { REPO_TOOL_DEFS, runRepoTool } from "./repoTools.ts";

// Forge keeps exploration quick and predictable: every request uses Haiku.
// There is intentionally no per-request model switch here.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CLI_MODEL = "haiku";

let apiDisabledReason: string | null = null;

export function llmMode(): "api" | "cli" {
  return process.env.ANTHROPIC_API_KEY && !apiDisabledReason ? "api" : "cli";
}

/** Billing/auth failures mean the key is unusable — switch to the CLI. */
function isApiAccessError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /credit balance|billing|invalid x-api-key|authentication_error|Anthropic API 401/i.test(message);
}

function disableApi(err: unknown): void {
  apiDisabledReason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  console.error(`Anthropic API path disabled (${apiDisabledReason}) — falling back to the local claude CLI.`);
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Caller-supplied tools executed locally; results feed back into the loop. */
export interface ExtraTools {
  defs: ToolDef[];
  run: (name: string, input: Record<string, unknown>) => Promise<string>;
}

interface StreamTextOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  onDelta?: (chunk: string) => void;
  /** Called when the model uses a tool (name, serialised input). */
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  /** Allow read-only repo tools to run from `cwd`. */
  tools?: boolean;
  cwd?: string;
  extraTools?: ExtraTools;
  maxTurns?: number;
}

// Streams text; calls onDelta(chunk) as text arrives. Resolves with full text.
export async function streamText({
  system,
  prompt,
  maxTokens = 4000,
  onDelta = () => {},
  onTool,
  signal,
  tools = false,
  cwd,
  extraTools,
  maxTurns = 8,
}: StreamTextOptions): Promise<string> {
  if (llmMode() === "api") {
    try {
      return await apiStream({ system, prompt, maxTokens, onDelta, onTool, signal, tools, cwd, extraTools, maxTurns });
    } catch (err) {
      if (signal?.aborted || !isApiAccessError(err)) throw err;
      disableApi(err);
    }
  }
  // CLI path: read-only repo tools via Claude Code's own Read/Grep/Glob.
  // Caller-supplied extra tools (GitHub reads) are API-only and skipped here.
  return cliStream({ system, prompt, onDelta, onTool, signal, maxTurns, tools: tools && cwd ? "read" : false, cwd });
}

// ---------- headless claude CLI path ----------

interface CliStreamOptions {
  system: string;
  prompt: string;
  onDelta: (chunk: string) => void;
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  maxTurns: number;
  /** "read" = Read/Grep/Glob in cwd; "write" adds Edit/Write (worktree only). */
  tools: false | "read" | "write";
  cwd?: string;
}

function cliStream({ system, prompt, onDelta, onTool, signal, maxTurns, tools, cwd }: CliStreamOptions): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args = ["-p", "--model", CLI_MODEL];
    if (tools && cwd) {
      const allowed = tools === "write" ? "Read,Grep,Glob,Edit,Write" : "Read,Grep,Glob";
      args.push("--max-turns", String(Math.max(maxTurns, tools === "write" ? 16 : 8)), "--allowedTools", allowed);
    } else {
      args.push("--max-turns", "1");
    }
    args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");

    // The CLI must use its own Claude Code login — never the (possibly dead)
    // API key that made us fall back here in the first place.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn("claude", args, {
      cwd: (tools && cwd) || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => child.kill("SIGKILL"), tools ? 300_000 : 120_000);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin!.write(`${system}\n\n${prompt}`);
    child.stdin!.end();

    let full = "";
    let sawDelta = false;
    let lineBuf = "";
    let stderr = "";

    child.stdout!.on("data", (d: Buffer) => {
      lineBuf += d.toString();
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
            } else if (onTool && ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
              onTool(String(ev.content_block.name || ""), JSON.stringify(ev.content_block.input || {}));
            }
          } else if (msg.type === "result" && typeof msg.result === "string" && !sawDelta) {
            full = msg.result;
          }
        } catch {
          /* non-JSON noise */
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      if (!full.trim()) return reject(new Error(`claude CLI produced no text (exit ${code}): ${stderr.slice(0, 300)}`));
      if (!sawDelta) onDelta(full);
      resolvePromise(full);
    });
  });
}

interface ApiStreamOptions {
  system: string;
  prompt: string;
  maxTokens: number;
  onDelta: (chunk: string) => void;
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
  tools?: boolean;
  cwd?: string;
  extraTools?: ExtraTools;
  maxTurns: number;
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

async function apiStream({ system, prompt, maxTokens, onDelta, onTool, signal, tools, cwd, extraTools, maxTurns }: ApiStreamOptions): Promise<string> {
  const repoToolsOn = !!(tools && cwd);
  const toolDefs: ToolDef[] = [
    ...(repoToolsOn ? (REPO_TOOL_DEFS as ToolDef[]) : []),
    ...(extraTools?.defs ?? []),
  ];
  const toolsOn = toolDefs.length > 0;
  const repoToolNames = new Set(REPO_TOOL_DEFS.map((d) => d.name));
  const messages: unknown[] = [{ role: "user", content: prompt }];
  let full = "";
  // Tool loop: run tools locally and hand results back until the model
  // answers with text. The final turn disables tool use so exploration can't
  // eat the whole budget and leave the meeting without a spoken answer.
  for (let turn = 0; turn < maxTurns; turn++) {
    const lastTurn = turn === maxTurns - 1;
    const { blocks, stopReason } = await apiTurn(
      {
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages,
        ...(toolsOn ? { tools: toolDefs } : {}),
        ...(toolsOn && lastTurn ? { tool_choice: { type: "none" } } : {}),
      },
      (t) => { full += t; onDelta(t); },
      onTool,
      signal
    );
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (!toolsOn || stopReason !== "tool_use" || toolUses.length === 0) return full;
    messages.push({ role: "assistant", content: blocks });
    const results = await Promise.all(
      toolUses.map(async (t) => {
        let content: string;
        if (repoToolsOn && repoToolNames.has(t.name)) content = runRepoTool(cwd!, t.name, t.input);
        else if (extraTools) content = await extraTools.run(t.name, t.input).catch((err) => `error: ${err instanceof Error ? err.message : String(err)}`);
        else content = `error: unknown tool ${t.name}`;
        return { type: "tool_result", tool_use_id: t.id, content };
      })
    );
    messages.push({ role: "user", content: results });
  }
  return full;
}

// ---------- controlled coding agent (issue → worktree edits) ----------
// The model may inspect and edit files inside ONE disposable worktree and
// nothing else. Forge itself owns git, validation, push, and the PR.

export interface CodingAgentRequest {
  cwd: string;
  repoDigest: string;
  issue: { number: number; title: string; body: string };
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
}

const CODE_TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".yml", ".yaml", ".toml", ".py", ".sh", ".txt"]);
const CODE_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".tts-cache", ".repo-cache"]);

function codingSystem(repoDigest: string): string {
  return `You are Forge's implementation agent. You are editing an isolated git worktree to solve one GitHub issue.

RULES:
- Inspect the relevant code with Read/Grep/Glob before editing. Make the smallest complete, production-quality change that satisfies the issue.
- Stay within the issue's scope. Match the project's existing style. No unrelated formatting churn, no generated files.
- You may use only Read, Glob, Grep, Edit, and Write. You have no shell, no git, no network, no secrets; Forge owns validation, commit, push, and the pull request.
- Prefer Edit for focused changes. Use Write only for a brand-new file or a genuinely safer full rewrite.
- When done, respond with a concise plain-English summary of what you changed and why.

Repository digest (orient yourself here, then verify against the worktree):
${repoDigest}`;
}

function codingPrompt(issue: CodingAgentRequest["issue"]): string {
  return `Implement this GitHub issue now.

Issue #${issue.number}: ${issue.title}

${issue.body || "No additional issue body was provided."}

First inspect the relevant files, then edit the worktree. Do not merely describe a solution: make the changes.`;
}

type ToolInput = Record<string, unknown>;

/** Resolve a model-supplied path strictly inside the worktree. */
function worktreePath(root: string, candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("tool path is required");
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("path escapes the implementation worktree");
  const rel = relative(base, target).split(sep);
  if (rel.includes(".git") || rel.includes("node_modules")) throw new Error("tool path is outside the editable source tree");
  return target;
}

async function filesUnder(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!CODE_SKIP_DIRS.has(entry.name)) result.push(...await filesUnder(root, resolve(dir, entry.name), depth + 1));
    } else if (entry.isFile() && CODE_TEXT_EXTENSIONS.has(extname(entry.name))) {
      result.push(relative(root, resolve(dir, entry.name)).replace(/\\/g, "/"));
    }
    if (result.length >= 900) break;
  }
  return result;
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

async function executeCodingTool(root: string, name: string, input: ToolInput): Promise<string> {
  switch (name) {
    case "Read": {
      const file = worktreePath(root, input.path);
      const text = await readFile(file, "utf8");
      const start = Math.max(1, Number(input.start_line) || 1);
      const end = Math.max(start, Number(input.end_line) || start + 299);
      return text.split("\n").slice(start - 1, Math.min(end, start + 499)).map((line, i) => `${start + i}: ${line}`).join("\n");
    }
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
      const match = globPattern(pattern);
      return (await filesUnder(root)).filter((f) => match.test(f)).slice(0, 200).join("\n") || "no files match";
    }
    case "Grep": {
      if (typeof input.pattern !== "string" || !input.pattern) throw new Error("grep pattern is required");
      let matcher: RegExp;
      try { matcher = new RegExp(input.pattern, "i"); } catch { matcher = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const scope = typeof input.path === "string" ? worktreePath(root, input.path) : root;
      const candidates = scope === root
        ? await filesUnder(root)
        : [relative(root, scope).replace(/\\/g, "/")];
      const matches: string[] = [];
      for (const path of candidates) {
        try {
          const lines = (await readFile(worktreePath(root, path), "utf8")).split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matcher.test(lines[i])) matches.push(`${path}:${i + 1}: ${lines[i].slice(0, 300)}`);
            if (matches.length >= 120) return matches.join("\n");
          }
        } catch { /* binary or unreadable file */ }
      }
      return matches.join("\n") || "no matches";
    }
    case "Write": {
      const file = worktreePath(root, input.path);
      if (typeof input.content !== "string") throw new Error("write content must be a string");
      if (input.content.length > 500_000) throw new Error("write is too large");
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, input.content, "utf8");
      return `wrote ${relative(root, file)}`;
    }
    case "Edit": {
      const file = worktreePath(root, input.path);
      if (typeof input.old_string !== "string" || typeof input.new_string !== "string") throw new Error("edit requires old_string and new_string");
      const text = await readFile(file, "utf8");
      const first = text.indexOf(input.old_string);
      if (first < 0) throw new Error("old_string was not found");
      if (text.indexOf(input.old_string, first + input.old_string.length) >= 0) throw new Error("old_string is ambiguous; include more context");
      await writeFile(file, text.slice(0, first) + input.new_string + text.slice(first + input.old_string.length), "utf8");
      return `edited ${relative(root, file)}`;
    }
    default:
      throw new Error(`unsupported coding tool: ${name}`);
  }
}

const CODE_TOOLS: ToolDef[] = [
  { name: "Read", description: "Read a UTF-8 file from the isolated worktree. Lines are numbered.", input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"] } },
  { name: "Glob", description: "List worktree files matching a glob such as src/**/*.ts.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "Grep", description: "Search UTF-8 source files. Optional path narrows to one file.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "Edit", description: "Make one exact, unambiguous replacement in an existing worktree file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "Write", description: "Create a new file or replace a complete file in the isolated worktree.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

/** Run the implementation agent against `request.cwd`. Returns its summary. */
export async function runCodingAgent(request: CodingAgentRequest): Promise<string> {
  if (llmMode() === "api") {
    try {
      return await apiCodingAgent(request);
    } catch (err) {
      if (request.signal?.aborted || !isApiAccessError(err)) throw err;
      disableApi(err);
    }
  }
  // CLI path: Claude Code's own editor tools, jailed to the worktree cwd.
  return cliStream({
    system: codingSystem(request.repoDigest),
    prompt: codingPrompt(request.issue),
    onDelta: () => {},
    onTool: request.onTool,
    signal: request.signal,
    maxTurns: 24,
    tools: "write",
    cwd: request.cwd,
  });
}

async function apiCodingAgent(request: CodingAgentRequest): Promise<string> {
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: codingPrompt(request.issue) },
  ];
  const MAX_TURNS = 24;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { blocks, stopReason } = await apiTurn(
      {
        model: HAIKU_MODEL,
        max_tokens: 4000,
        stream: true,
        system: codingSystem(request.repoDigest),
        messages,
        tools: CODE_TOOLS,
        ...(turn === MAX_TURNS - 1 ? { tool_choice: { type: "none" } } : {}),
      },
      () => {},
      request.onTool,
      request.signal
    );
    const calls = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (stopReason !== "tool_use" || !calls.length) {
      const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return text || "Implemented the issue in the isolated worktree.";
    }
    messages.push({ role: "assistant", content: blocks });
    const results = await Promise.all(calls.map(async (call) => {
      try {
        return { type: "tool_result", tool_use_id: call.id, content: await executeCodingTool(request.cwd, call.name, call.input || {}) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: call.id, is_error: true, content: err instanceof Error ? err.message : String(err) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  throw new Error("coding agent exceeded its tool-turn limit");
}
