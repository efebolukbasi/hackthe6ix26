// The controlled issue → implementation → pull-request workflow. Forge reads
// the GitHub issue, lets the jailed coding agent edit an isolated git
// worktree, validates the result, then pushes a dedicated branch and opens
// the PR itself. The model never touches git, credentials, or the network.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { runCodingAgent } from "./llm.ts";
import * as github from "./github.ts";

const execFileP = promisify(execFile);

export interface PullRequestResult {
  html_url: string;
  number: number;
  title: string;
  branch: string;
  created: boolean;
  summary: string;
  checks: string[];
}

export interface ImplementProgress {
  onPhase?: (text: string) => void;
  onTool?: (name: string, input: string) => void;
  signal?: AbortSignal;
}

function flowError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

function safeBranchPart(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "") || "change";
}

function readPackageDirs(root: string, dir = root, depth = 0): string[] {
  if (depth > 3) return [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  const found = existsSync(join(dir, "package.json")) ? [dir] : [];
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build", ".next"].includes(entry)) continue;
    const child = join(dir, entry);
    try {
      if (readdirSync(child)) found.push(...readPackageDirs(root, child, depth + 1));
    } catch { /* file */ }
  }
  return found;
}

/** Symlink installed node_modules from the source checkout into the worktree
 * so typecheck validation works without a fresh install. */
function linkDependencies(sourceRoot: string, worktree: string): void {
  for (const sourceDir of readPackageDirs(sourceRoot)) {
    const modules = join(sourceDir, "node_modules");
    if (!existsSync(modules)) continue;
    const rel = relative(sourceRoot, sourceDir);
    const target = join(worktree, rel, "node_modules");
    try { symlinkSync(modules, target, "dir"); } catch { /* absent or already linked */ }
  }
}

async function validateWorktree(worktree: string, onPhase?: (text: string) => void): Promise<string[]> {
  await execFileP("git", ["-C", worktree, "diff", "--check"], { timeout: 20_000 });
  const checks = ["git diff --check"];
  for (const dir of readPackageDirs(worktree).slice(0, 8)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.typecheck) continue;
      onPhase?.(`typechecking ${relative(worktree, dir) || "."}`);
      await execFileP("npm", ["run", "typecheck"], { cwd: dir, timeout: 180_000 });
      checks.push(`${relative(worktree, dir) || "."}: npm run typecheck`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw flowError(`Validation failed in ${relative(worktree, dir) || "."}: ${message.slice(0, 400)}`, 422);
    }
  }
  return checks;
}

async function cleanupWorktree(repoPath: string, worktree: string): Promise<void> {
  try { await execFileP("git", ["-C", repoPath, "worktree", "remove", "--force", worktree], { timeout: 15_000 }); } catch { /* fall through */ }
  const sandbox = dirname(worktree);
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
}

// One implementation per issue at a time; concurrent asks join the same run.
const inFlight = new Map<string, Promise<PullRequestResult>>();

export async function implementIssue(
  repoPath: string,
  number: number,
  repoDigest: string,
  slugHint?: string,
  progress: ImplementProgress = {}
): Promise<PullRequestResult> {
  const slug = await github.resolveSlug(repoPath, slugHint);
  const operationKey = `${slug}:${number}`;
  const current = inFlight.get(operationKey);
  if (current) return current;
  const run = implementIssueOnce(repoPath, number, repoDigest, slug, progress);
  inFlight.set(operationKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(operationKey);
  }
}

async function implementIssueOnce(
  repoPath: string,
  number: number,
  repoDigest: string,
  slug: string,
  progress: ImplementProgress
): Promise<PullRequestResult> {
  const { onPhase, onTool, signal } = progress;
  onPhase?.(`reading issue #${number}`);
  const [issue, base] = await Promise.all([
    github.getIssue(repoPath, number, slug),
    github.defaultBranch(slug),
  ]);
  if (issue.state !== "open") throw flowError(`Issue #${number} is closed`, 409);

  const branch = `forge/issue-${number}-${safeBranchPart(issue.title)}`;
  const existing = await github.findOpenPullRequest(slug, branch);
  if (existing) {
    return { ...existing, branch, created: false, summary: "An open Forge pull request already exists for this issue.", checks: [] };
  }

  // `git worktree add` requires a path that does not exist yet; mkdtemp gives
  // a unique parent and Git owns the child path.
  const sandbox = await mkdtemp(join(tmpdir(), `forge-issue-${number}-`));
  const worktree = join(sandbox, "repo");
  try {
    onPhase?.("preparing an isolated worktree");
    await execFileP("git", ["-C", repoPath, "worktree", "add", "--detach", worktree, base], { timeout: 30_000 })
      .catch(async () => {
        // Shallow or fetch-less checkouts may lack a local ref for the default
        // branch — fall back to the current HEAD.
        await execFileP("git", ["-C", repoPath, "worktree", "add", "--detach", worktree, "HEAD"], { timeout: 30_000 });
      });
    await execFileP("git", ["-C", worktree, "checkout", "-b", branch], { timeout: 15_000 });
    linkDependencies(repoPath, worktree);

    onPhase?.("implementing the change");
    // The linked node_modules make the worktree look dirty — real changes are
    // everything EXCEPT those paths (the symlink itself included, hence
    // ":(exclude)**/node_modules" and not ".../**").
    const realChanges = () =>
      execFileP("git", ["-C", worktree, "status", "--porcelain", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"], { timeout: 10_000 })
        .then(({ stdout }) => stdout.split("\n").filter((line) => line.trim() && !/node_modules\/?$/.test(line.trim())).length > 0);

    let summary = await runCodingAgent({
      cwd: worktree,
      repoDigest,
      issue: { number: issue.number, title: issue.title, body: issue.body || "" },
      onTool,
      signal,
    });
    if (!(await realChanges())) {
      // The model described a plan without editing — one stern retry.
      onPhase?.("no edits made — retrying with a firmer instruction");
      summary = await runCodingAgent({
        cwd: worktree,
        repoDigest,
        issue: {
          number: issue.number,
          title: issue.title,
          body: `${issue.body || ""}\n\nIMPORTANT: your previous attempt produced NO file edits. Do not describe a plan. Call Edit or Write on real files until the change is complete.`,
        },
        onTool,
        signal,
      });
    }
    if (!(await realChanges())) throw flowError("Forge inspected the issue but made no code changes", 422);

    onPhase?.("validating the change");
    const checks = await validateWorktree(worktree, onPhase);

    // Validation may symlink node_modules into the worktree — exclude them
    // (symlink AND contents) even if the target repo lacks a .gitignore entry.
    await execFileP("git", ["-C", worktree, "add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude)**/node_modules"], { timeout: 15_000 });
    await execFileP("git", ["-C", worktree, "config", "user.name", "Forge"], { timeout: 5000 });
    await execFileP("git", ["-C", worktree, "config", "user.email", "forge@users.noreply.github.com"], { timeout: 5000 });
    await execFileP("git", ["-C", worktree, "commit", "-m", `fix: ${issue.title.slice(0, 62)} (#${issue.number})`], { timeout: 60_000 });

    onPhase?.(`pushing ${branch}`);
    const token = await github.githubToken();
    const originalRemote = await execFileP("git", ["-C", worktree, "remote", "get-url", "origin"], { timeout: 5000 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => null);
    const pushUrl = github.tokenizedCloneUrl(`https://github.com/${slug}.git`, token);
    try {
      await execFileP("git", ["-C", worktree, "push", pushUrl, `${branch}:${branch}`], { timeout: 120_000 });
    } finally {
      if (originalRemote) {
        await execFileP("git", ["-C", worktree, "remote", "set-url", "origin", originalRemote], { timeout: 5000 }).catch(() => {});
      }
    }

    onPhase?.("opening the pull request");
    const pull = await github.openPullRequest(slug, {
      title: `Fix #${issue.number}: ${issue.title}`,
      head: branch,
      base,
      body: `Closes #${issue.number}.\n\n${summary.slice(0, 1500)}\n\nValidation:\n${checks.map((c) => `- ${c}`).join("\n")}\n\n_Opened by Forge from a meeting._`,
    });
    return { ...pull, branch, created: true, summary: summary.slice(0, 600), checks };
  } finally {
    await cleanupWorktree(repoPath, worktree);
  }
}
