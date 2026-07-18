// GitHub connection for Forge. Token sources, in priority order:
//   1. GITHUB_TOKEN env
//   2. the host's `gh` CLI login (zero-click when the demo machine has gh)
//   3. OAuth device flow (needs GITHUB_CLIENT_ID; user enters a short code
//      on github.com — no callback URL, works through tunnels)
// The token stays server-side and in memory; it is never sent to the frontend.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let deviceToken: string | null = null;
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

export async function githubToken(): Promise<string | null> {
  return process.env.GITHUB_TOKEN || deviceToken || (await ghCliToken());
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
  via?: "env" | "device" | "gh";
  deviceFlowAvailable: boolean;
}

export async function status(): Promise<GithubStatus> {
  const deviceFlowAvailable = !!process.env.GITHUB_CLIENT_ID;
  const token = await githubToken();
  if (!token) return { connected: false, deviceFlowAvailable };
  try {
    const user = await api<{ login: string }>("/user", token);
    const via = process.env.GITHUB_TOKEN ? "env" : deviceToken ? "device" : "gh";
    return { connected: true, user: user.login, via, deviceFlowAvailable };
  } catch {
    return { connected: false, deviceFlowAvailable };
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

// ---- device flow ----

export async function deviceStart(): Promise<{ user_code: string; verification_uri: string; device_code: string; interval: number }> {
  const client_id = process.env.GITHUB_CLIENT_ID;
  if (!client_id) throw Object.assign(new Error("GITHUB_CLIENT_ID not set"), { status: 400 });
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id, scope: "repo" }),
  });
  if (!res.ok) throw new Error(`device start ${res.status}`);
  return res.json() as Promise<{ user_code: string; verification_uri: string; device_code: string; interval: number }>;
}

export async function devicePoll(device_code: string): Promise<{ status: "ok" | "pending" | "error"; user?: string; error?: string }> {
  const client_id = process.env.GITHUB_CLIENT_ID;
  if (!client_id) return { status: "error", error: "GITHUB_CLIENT_ID not set" };
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const out = (await res.json()) as { access_token?: string; error?: string };
  if (out.access_token) {
    deviceToken = out.access_token;
    const s = await status();
    return { status: "ok", user: s.user };
  }
  if (out.error === "authorization_pending" || out.error === "slow_down") return { status: "pending" };
  return { status: "error", error: out.error };
}

/** Clone URL with the token injected (stripped from the git remote after clone). */
export function tokenizedCloneUrl(url: string, token: string | null): string {
  if (!token) return url;
  return url.replace(/^https:\/\/github\.com\//, `https://x-access-token:${token}@github.com/`);
}
