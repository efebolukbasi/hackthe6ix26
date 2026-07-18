// GitHub connection for Forge. The deployment's GITHUB_TOKEN is the only
// credential used for repository browsing, cloning, and issue creation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let ghCliToken: { token: string | null; at: number } | null = null;

export async function githubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Local-dev fallback: an authenticated `gh` CLI login means repo browsing
  // and issue creation work with zero .env configuration.
  if (ghCliToken && Date.now() - ghCliToken.at < 300_000) return ghCliToken.token;
  try {
    const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 5000 });
    ghCliToken = { token: stdout.trim() || null, at: Date.now() };
  } catch {
    ghCliToken = { token: null, at: Date.now() };
  }
  return ghCliToken.token;
}

/** owner/repo slug for the repo at `repoPath`, from its git origin remote. */
export async function repoSlugFor(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"], { timeout: 5000 });
    const m = stdout.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function api<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<T>;
}

export interface GithubStatus {
  connected: boolean;
  user?: string;
  via?: "env" | "gh";
}

export async function status(): Promise<GithubStatus> {
  const token = await githubToken();
  if (!token) return { connected: false };
  try {
    const user = await api<{ login: string }>("/user", token);
    return { connected: true, user: user.login, via: process.env.GITHUB_TOKEN ? "env" : "gh" };
  } catch {
    return { connected: false };
  }
}

export interface RepoInfo {
  full_name: string;
  private: boolean;
  pushed_at: string;
  description: string | null;
}

export async function listRepos(): Promise<RepoInfo[]> {
  const token = await githubToken();
  if (!token) throw Object.assign(new Error("not connected to GitHub"), { status: 401 });
  const repos = await api<RepoInfo[]>("/user/repos?sort=pushed&per_page=100", token);
  return repos.map((r) => ({
    full_name: r.full_name,
    private: r.private,
    pushed_at: r.pushed_at,
    description: r.description,
  }));
}

export interface CreatedIssue {
  html_url: string;
  number: number;
  title: string;
}

/** Create an issue in the repository checked out at `repoPath`. `slugHint`
 * (tracked when the repo was loaded from a GitHub URL) takes precedence over
 * sniffing the git origin, so issues work even when the checkout has no
 * usable remote. */
export async function createIssue(repoPath: string, title: string, body: string, slugHint?: string): Promise<CreatedIssue> {
  const token = await githubToken();
  if (!token) {
    throw Object.assign(
      new Error("No GitHub access — set GITHUB_TOKEN in the backend environment, or log in with the gh CLI"),
      { status: 401 }
    );
  }

  const envSlug = (process.env.GITHUB_REPO || "").match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
  const slug = slugHint || (await repoSlugFor(repoPath)) || envSlug;
  if (!slug) {
    throw Object.assign(
      new Error("Couldn't determine the GitHub repository — pick one from the repo picker, or add a GitHub 'origin' remote to the active repo"),
      { status: 400 }
    );
  }

  const res = await fetch(`https://api.github.com/repos/${slug}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: title.slice(0, 180), body: body.slice(0, 6000) }),
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
  return res.json() as Promise<CreatedIssue>;
}

/** Clone URL with the token injected (stripped from the git remote after clone). */
export function tokenizedCloneUrl(url: string, token: string | null): string {
  if (!token) return url;
  return url.replace(/^https:\/\/github\.com\//, `https://x-access-token:${token}@github.com/`);
}
