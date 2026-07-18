// Repo intelligence: builds a compact digest of a codebase that fits in the
// agent's system prompt. Tree + prioritized file contents + git history.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { RepoMeta } from "./types.ts";

const execFileP = promisify(execFile);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".tts-cache", "coverage", ".vercel", ".repo-cache"]);
export const TEXT_EXT = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".html", ".css", ".md", ".json", ".yml", ".yaml", ".toml", ".sh", ".txt"]);

const TOTAL_BUDGET = 150_000; // chars of file content in the digest
const PER_FILE_CAP = 12_000;

export interface FileEntry {
  path: string;
  full: string;
  size: number;
}

export function walkFiles(root: string): FileEntry[] {
  const files: FileEntry[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        files.push({ path: relative(root, full), full, size });
      }
    }
  };
  visit(root);
  return files;
}

// Lower score = higher priority for inclusion.
function priority(p: string): number {
  const name = basename(p).toLowerCase();
  if (name.startsWith("readme")) return 0;
  if (name === "package.json") return 1;
  if (p.includes("server") || name.includes("agent") || name.includes("brain")) return 2;
  if (extname(p) === ".md") return 3;
  if ([".js", ".mjs", ".ts", ".tsx", ".jsx", ".py"].includes(extname(p))) return 4;
  if ([".html", ".css"].includes(extname(p))) return 6;
  return 8;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, ...args], { timeout: 8000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

const MAX_TREE_FILES = 500; // keep the digest's tree section sane for big repos

// Prefix each line with its real line number so the agent can cite exact
// locations (attr fields, code cards) straight from the digest.
function numberLines(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n");
}

export async function buildDigest(repoPath: string): Promise<{ digest: string; meta: RepoMeta }> {
  const files = walkFiles(repoPath);
  const tree =
    files.slice(0, MAX_TREE_FILES).map((f) => `${f.path} (${f.size}b)`).join("\n") +
    (files.length > MAX_TREE_FILES ? `\n…and ${files.length - MAX_TREE_FILES} more files` : "");

  const candidates = files
    .filter((f) => TEXT_EXT.has(extname(f.path)) || basename(f.path).toLowerCase().startsWith("readme"))
    .sort((a, b) => priority(a.path) - priority(b.path) || a.size - b.size);

  let used = 0;
  const chunks: string[] = [];
  for (const f of candidates) {
    if (used >= TOTAL_BUDGET) break;
    let content: string;
    try {
      content = readFileSync(f.full, "utf8");
    } catch {
      continue;
    }
    content = numberLines(content);
    if (content.length > PER_FILE_CAP) {
      // Truncate at a line boundary so the numbering stays honest.
      const cut = content.lastIndexOf("\n", PER_FILE_CAP);
      content = content.slice(0, cut > 0 ? cut : PER_FILE_CAP) + "\n…(truncated)";
    }
    if (used + content.length > TOTAL_BUDGET) continue;
    used += content.length;
    chunks.push(`----- FILE: ${f.path} -----\n${content}`);
  }

  const log = await git(repoPath, ["log", "--oneline", "--no-decorate", "-n", "15"]);
  const branch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);

  const digest = [
    `Repository root: ${basename(repoPath)}${branch ? ` (branch ${branch})` : ""}`,
    `\n== FILE TREE ==\n${tree}`,
    log ? `\n== RECENT COMMITS ==\n${log}` : "",
    `\n== FILE CONTENTS (prioritized, may be truncated; each line is prefixed with its real line number) ==\n${chunks.join("\n\n")}`,
  ].join("\n");

  return {
    digest,
    meta: { name: basename(repoPath), fileCount: files.length, includedFiles: chunks.length, chars: digest.length },
  };
}
