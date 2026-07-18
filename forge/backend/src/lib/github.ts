// GitHub connection for Forge. The deployment's GITHUB_TOKEN is the only
// credential used for repository browsing, cloning, and issue creation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function githubToken(): Promise<string | null> {
  return process.env.GITHUB_TOKEN || null;
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
  via?: "env";
}

export async function status(): Promise<GithubStatus> {
  const token = await githubToken();
  if (!token) return { connected: false };
  try {
    const user = await api<{ login: string }>("/user", token);
    return { connected: true, user: user.login, via: "env" };
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

/** Create an issue in the repository checked out at `repoPath`. */
export async function createIssue(repoPath: string, title: string, body: string): Promise<CreatedIssue> {
  const token = await githubToken();
  if (!token) throw Object.assign(new Error("Connect GitHub before creating an issue"), { status: 401 });

  let remote: string;
  try {
    const result = await execFileP("git", ["-C", repoPath, "remote", "get-url", "origin"], { timeout: 5000 });
    remote = result.stdout.trim();
  } catch {
    throw Object.assign(new Error("The active repository has no GitHub origin"), { status: 400 });
  }
  const match = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw Object.assign(new Error("The active repository is not hosted on GitHub"), { status: 400 });

  const res = await fetch(`https://api.github.com/repos/${match[1]}/issues`, {
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
