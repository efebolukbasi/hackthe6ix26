// GitHub connection for Forge. A GitHub App user token is scoped to the
// current browser session; environment and `gh` tokens remain local fallbacks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let cachedGhToken: string | null | undefined; // undefined = not probed yet

async function ghCliToken(): Promise<string | null> {
  if (cachedGhToken !== undefined) return cachedGhToken;
  try {
    const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 5000 });
    cachedGhToken = stdout.trim() || null;
  } catch {
    cachedGhToken = null;
  }
  return cachedGhToken;
}

export async function githubToken(userToken?: string | null): Promise<string | null> {
  return userToken || process.env.GITHUB_TOKEN || (await ghCliToken());
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
  via?: "app" | "env" | "gh";
}

export async function status(userToken?: string | null): Promise<GithubStatus> {
  const token = await githubToken(userToken);
  if (!token) return { connected: false };
  try {
    const user = await api<{ login: string }>("/user", token);
    const via = userToken ? "app" : process.env.GITHUB_TOKEN ? "env" : "gh";
    return { connected: true, user: user.login, via };
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

export async function listRepos(userToken?: string | null): Promise<RepoInfo[]> {
  const token = await githubToken(userToken);
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
export async function createIssue(repoPath: string, title: string, body: string, userToken?: string | null): Promise<CreatedIssue> {
  const token = await githubToken(userToken);
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

/** Exchange a GitHub App web-flow code for a user-to-server access token. */
export async function exchangeWebCode(code: string, redirectUri: string): Promise<string> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw Object.assign(new Error("GitHub App is not configured"), { status: 503 });
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const out = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !out.access_token) {
    throw Object.assign(new Error(out.error_description || out.error || "GitHub authorization failed"), { status: 502 });
  }
  return out.access_token;
}

/** Clone URL with the token injected (stripped from the git remote after clone). */
export function tokenizedCloneUrl(url: string, token: string | null): string {
  if (!token) return url;
  return url.replace(/^https:\/\/github\.com\//, `https://x-access-token:${token}@github.com/`);
}
