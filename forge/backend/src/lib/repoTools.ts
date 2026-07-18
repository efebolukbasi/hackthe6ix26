// Read-only repository tools for the direct Anthropic API path. llm.ts
// executes these locally against the loaded repo and feeds results back.
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { walkFiles, TEXT_EXT } from "./repo.ts";

/** Anthropic Messages API tool definitions for the repo tools. */
export const REPO_TOOL_DEFS = [
  {
    name: "read_file",
    description:
      "Read a file from the team's repository. Returns the requested lines, each prefixed with its real line number.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
        start_line: { type: "integer", description: "First line to read (1-based, default 1)" },
        end_line: { type: "integer", description: "Last line to read (default: start_line + 200)" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search the repository's text files with a JavaScript regular expression. Returns matches as path:line: text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path_filter: { type: "string", description: "Only search files whose path contains this substring" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_files",
    description: "List repository file paths, optionally filtered by a substring.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only list paths containing this substring" },
      },
    },
  },
];

const MAX_READ_LINES = 400;
const MAX_GREP_MATCHES = 60;
const MAX_LIST_FILES = 500;
const MAX_SCAN_BYTES = 512 * 1024; // don't grep through huge generated files

function readFileTool(cwd: string, input: Record<string, unknown>): string {
  const rel = String(input.path || "").trim();
  if (!rel) return "error: no path given";
  const abs = resolve(cwd, rel);
  // Tools must never escape the repo, no matter what path the model asks for.
  if (!abs.startsWith(resolve(cwd) + "/") && abs !== resolve(cwd)) return "error: path escapes the repository";
  if (!existsSync(abs)) return `error: ${rel} not found`;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return `error: could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const lines = content.split("\n");
  const start = Math.max(1, Number(input.start_line) || 1);
  const requestedEnd = Number(input.end_line) || start + 200;
  const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
  const width = String(end).length;
  const out = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}| ${l.slice(0, 500)}`)
    .join("\n");
  const suffix = end < lines.length ? `\n…(file continues to line ${lines.length})` : "";
  return `${rel} (lines ${start}-${end} of ${lines.length}):\n${out}${suffix}`;
}

function grepTool(cwd: string, input: Record<string, unknown>): string {
  let re: RegExp;
  try {
    re = new RegExp(String(input.pattern || ""), "i");
  } catch (err) {
    return `error: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  const filter = String(input.path_filter || "").toLowerCase();
  const matches: string[] = [];
  for (const f of walkFiles(cwd)) {
    if (!TEXT_EXT.has(extname(f.path))) continue;
    if (filter && !f.path.toLowerCase().includes(filter)) continue;
    if (f.size > MAX_SCAN_BYTES) continue;
    let content: string;
    try {
      content = readFileSync(f.full, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      matches.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      if (matches.length >= MAX_GREP_MATCHES) {
        return matches.join("\n") + "\n…(more matches truncated)";
      }
    }
  }
  return matches.length ? matches.join("\n") : "no matches";
}

function listFilesTool(cwd: string, input: Record<string, unknown>): string {
  const filter = String(input.filter || "").toLowerCase();
  const paths = walkFiles(cwd)
    .map((f) => f.path)
    .filter((p) => !filter || p.toLowerCase().includes(filter));
  const shown = paths.slice(0, MAX_LIST_FILES);
  const suffix = paths.length > shown.length ? `\n…and ${paths.length - shown.length} more` : "";
  return shown.length ? shown.join("\n") + suffix : "no files match";
}

/** Execute a repo tool by name; always returns a string result for the model. */
export function runRepoTool(cwd: string, name: string, input: Record<string, unknown>): string {
  try {
    if (name === "read_file") return readFileTool(cwd, input);
    if (name === "grep") return grepTool(cwd, input);
    if (name === "list_files") return listFilesTool(cwd, input);
    return `error: unknown tool ${name}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
