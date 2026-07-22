// GitHub access for Forge. Any meeting participant can sign in with their own
// GitHub account (OAuth device flow, or a pasted personal access token); the
// browser only ever holds an opaque session id — tokens live in backend
// memory. The participant whose account loaded the active repo "lends" it to
// the meeting: cloning, issue reading/creation, branch pushes and pull
// requests all run with that grant. A deployment GITHUB_TOKEN (or local `gh`
// CLI login) remains as a zero-config fallback.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ISSUE_MARKER = "forge-issue-key";
const MAX_ISSUE_BODY = 20_000;

let ghCliToken: { token: string | null; at: number } | null = null;

/** Deployment-level credential: GITHUB_TOKEN env, else a local `gh` login. */
export async function fallbackToken(): Promise<string | null> {
  const configured = process.env.GITHUB_TOKEN?.trim();
  if (configured) return configured;
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

// ---------- per-participant sign-in ----------

export interface SessionAuth {
  token: string;
  login: string;
}

interface PendingLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  /** Terminal device-flow failure (denied, expired) — shown in the picker. */
  error?: string;
}

const sessionAuths = new Map<string, SessionAuth>();
const pendingLogins = new Map<string, PendingLogin>();

// The credential behind the ACTIVE repo. Set when a signed-in participant
// loads a repository; null means operations fall back to the deployment token.
let activeGrant: SessionAuth | null = null;

export function sessionAuth(sessionId: string | undefined): SessionAuth | null {
  return (sessionId && sessionAuths.get(sessionId)) || null;
}

/** Bind all GitHub operations on the active repo to this participant. */
export function setActiveGrant(grant: SessionAuth | null): void {
  activeGrant = grant;
}

/** The token GitHub operations on the active repo run with. */
export async function githubToken(): Promise<string | null> {
  if (activeGrant) return activeGrant.token;
  return fallbackToken();
}

export function oauthClientId(): string | null {
  return process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start a GitHub OAuth device-flow login for a participant: returns the code
 * they type at github.com/login/device, and polls GitHub in the background
 * until the login completes (status() reports the result).
 */
export async function startDeviceLogin(sessionId: string): Promise<{ userCode: string; verificationUri: string }> {
  const clientId = oauthClientId();
  if (!clientId) {
    throw Object.assign(new Error("GitHub sign-in isn't configured — set GITHUB_OAUTH_CLIENT_ID in the backend environment"), { status: 400 });
  }
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`GitHub device login failed (${res.status})`), { status: 502 });
  }
  const data = (await res.json()) as {
    device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string;
  };
  if (!data.device_code || !data.user_code) {
    throw Object.assign(new Error(`GitHub device login failed: ${data.error || "no device code"}`), { status: 502 });
  }
  const pending: PendingLogin = {
    userCode: data.user_code,
    verificationUri: data.verification_uri || "https://github.com/login/device",
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
  };
  pendingLogins.set(sessionId, pending);
  void pollDeviceLogin(sessionId, clientId, data.device_code, Math.max(5, data.interval ?? 5), pending);
  return { userCode: pending.userCode, verificationUri: pending.verificationUri };
}

async function pollDeviceLogin(
  sessionId: string,
  clientId: string,
  deviceCode: string,
  intervalSec: number,
  pending: PendingLogin
): Promise<void> {
  // A re-triggered login replaces the map entry — the old loop must die.
  while (pendingLogins.get(sessionId) === pending && Date.now() < pending.expiresAt) {
    await sleep(intervalSec * 1000);
    if (pendingLogins.get(sessionId) !== pending) return;
    let data: { access_token?: string; error?: string; interval?: number };
    try {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      data = (await res.json()) as typeof data;
    } catch {
      continue; // transient network blip — keep polling
    }
    if (data.access_token) {
      try {
        const user = await api<{ login: string }>("/user", data.access_token);
        sessionAuths.set(sessionId, { token: data.access_token, login: user.login });
      } catch {
        pending.error = "GitHub authorized the login but the token didn't work — try again";
      }
      pendingLogins.delete(sessionId);
      return;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { intervalSec += 5; continue; }
    pending.error = data.error === "access_denied"
      ? "GitHub sign-in was cancelled"
      : `GitHub sign-in ${data.error === "expired_token" ? "code expired" : `failed (${data.error || "unknown error"})`} — try again`;
    return;
  }
  if (pendingLogins.get(sessionId) === pending && !pending.error) {
    pending.error = "GitHub sign-in code expired — try again";
  }
}

/** Fallback sign-in: validate a pasted personal access token for this session. */
export async function connectWithToken(sessionId: string, token: string): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw Object.assign(new Error("empty token"), { status: 400 });
  let user: { login: string };
  try {
    user = await api<{ login: string }>("/user", trimmed);
  } catch {
    throw Object.assign(new Error("GitHub rejected that token"), { status: 401 });
  }
  sessionAuths.set(sessionId, { token: trimmed, login: user.login });
  pendingLogins.delete(sessionId);
  return user.login;
}

/** Forget this participant's sign-in. A repo they already loaded keeps its
 * grant — revoking mid-meeting would break the room's active repo. */
export function logout(sessionId: string): void {
  sessionAuths.delete(sessionId);
  pendingLogins.delete(sessionId);
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

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`),
      { status: res.status }
    );
  }
  return res.json() as Promise<T>;
}

export interface GithubStatus {
  connected: boolean;
  user?: string;
  via?: "oauth" | "env" | "gh";
  /** Whether "Sign in with GitHub" (device flow) is configured. */
  authAvailable?: boolean;
  /** A device-flow login is awaiting the user at github.com/login/device. */
  pending?: { userCode: string; verificationUri: string };
  /** Safe diagnostic for the repo picker. Never includes a token. */
  error?: string;
}

/** This participant's GitHub connection: their own sign-in first, then any
 * pending device-flow login, then the deployment fallback credential. */
export async function status(sessionId?: string): Promise<GithubStatus> {
  const authAvailable = !!oauthClientId();
  const auth = sessionAuth(sessionId);
  if (auth) return { connected: true, user: auth.login, via: "oauth", authAvailable };
  const pending = sessionId ? pendingLogins.get(sessionId) : undefined;
  if (pending && !pending.error && Date.now() < pending.expiresAt) {
    return { connected: false, authAvailable, pending: { userCode: pending.userCode, verificationUri: pending.verificationUri } };
  }
  const loginError = pending?.error;
  const token = await fallbackToken();
  if (!token) return { connected: false, authAvailable, error: loginError };
  try {
    const user = await api<{ login: string }>("/user", token);
    return { connected: true, user: user.login, via: process.env.GITHUB_TOKEN?.trim() ? "env" : "gh", authAvailable, error: loginError };
  } catch (err) {
    return { connected: false, authAvailable, error: loginError ?? (err instanceof Error ? err.message : String(err)).slice(0, 240) };
  }
}

/** The owner/repository for the deployment itself, when one is known. */
export function configuredRepoSlug(): string | null {
  const explicit = process.env.GITHUB_REPO?.trim();
  if (explicit) {
    const urlMatch = explicit.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
    if (urlMatch) return urlMatch[1];
    if (/^[\w.-]+\/[\w.-]+$/.test(explicit)) return explicit;
  }
  // Render sets this for Git-based services, including deployments where the
  // checked-out source has no usable .git directory at runtime.
  const renderSlug = process.env.RENDER_GIT_REPO_SLUG?.trim();
  return renderSlug && /^[\w.-]+\/[\w.-]+$/.test(renderSlug) ? renderSlug : null;
}

export interface RepoInfo {
  full_name: string;
  private: boolean;
  pushed_at: string;
  description: string | null;
}

/** The calling participant's repos — their own sign-in, else the fallback. */
export async function listRepos(sessionId?: string): Promise<RepoInfo[]> {
  const token = sessionAuth(sessionId)?.token ?? (await fallbackToken());
  if (!token) throw Object.assign(new Error("not connected to GitHub"), { status: 401 });
  const repos = await api<RepoInfo[]>("/user/repos?sort=pushed&per_page=100", token);
  return repos.map((r) => ({
    full_name: r.full_name,
    private: r.private,
    pushed_at: r.pushed_at,
    description: r.description,
  }));
}

function noAccessError(): Error {
  return Object.assign(
    new Error("No GitHub access — set GITHUB_TOKEN in the backend environment, or log in with the gh CLI"),
    { status: 401 }
  );
}

/** Resolve the active repo's owner/repo slug, preferring the load-time hint. */
export async function resolveSlug(repoPath: string, slugHint?: string): Promise<string> {
  const slug = slugHint || (await repoSlugFor(repoPath)) || configuredRepoSlug();
  if (!slug) {
    throw Object.assign(
      new Error("Couldn't determine the GitHub repository — pick one from the repo picker, or add a GitHub 'origin' remote to the active repo"),
      { status: 400 }
    );
  }
  return slug;
}

// ---------- issues ----------

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

export interface CreatedIssue {
  html_url: string;
  number: number;
  title: string;
  /** True only when Forge sent a POST to GitHub during this request. */
  created: boolean;
  /** True when an equivalent recent issue was reused instead of duplicated. */
  duplicate: boolean;
}

/** Fold spelled-out numbers so "eleven labs" and "11 labs" dedupe together.
 * Used ONLY for duplicate detection — never for displayed text. */
function normalizeIssueText(value: string): string {
  const words: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11",
  };
  return value
    .toLowerCase()
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\b/g, (w) => words[w])
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  const ignored = new Set(["a", "an", "the", "to", "for", "in", "on", "and", "or", "with", "issue", "of"]);
  return new Set(normalizeIssueText(title).split(" ").filter((t) => t.length > 1 && !ignored.has(t)));
}

function equivalentTitle(a: string, b: string): boolean {
  const na = normalizeIssueText(a);
  const nb = normalizeIssueText(b);
  if (na === nb) return true;
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size < 3 || right.size < 3) return false;
  let intersection = 0;
  for (const t of left) if (right.has(t)) intersection++;
  return intersection / new Set([...left, ...right]).size >= 0.8;
}

const markerFor = (key: string): string => `<!-- ${ISSUE_MARKER}:${key} -->`;

function canonicalKey(title: string, requestKey?: string): string {
  if (requestKey && /^[a-f0-9-]{8,64}$/i.test(requestKey)) return requestKey.toLowerCase();
  return createHash("sha256").update(normalizeIssueText(title)).digest("hex").slice(0, 32);
}

async function recentIssues(slug: string, token: string): Promise<GithubIssue[]> {
  const issues = await api<GithubIssue[]>(`/repos/${slug}/issues?state=all&sort=created&direction=desc&per_page=100`, token);
  return issues.filter((i) => !i.pull_request);
}

// In-memory coalescing absorbs concurrent duplicate requests (double-fired
// speech finals, retries). The marker + title similarity make deduplication
// survive a reload or restart.
const inFlightIssueCreates = new Map<string, Promise<CreatedIssue>>();

/** Create an issue exactly once for an intent, or return its existing equivalent. */
export async function createOrReuseIssue(
  repoPath: string,
  title: string,
  body: string,
  slugHint?: string,
  requestKey?: string
): Promise<CreatedIssue> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  const slug = await resolveSlug(repoPath, slugHint);
  const key = canonicalKey(title, requestKey);
  const operationKey = `${slug}:${key}`;
  const current = inFlightIssueCreates.get(operationKey);
  if (current) return current;

  const run = (async (): Promise<CreatedIssue> => {
    const issues = await recentIssues(slug, token).catch(() => [] as GithubIssue[]);
    const marked = issues.find((i) => (i.body || "").includes(markerFor(key)));
    const similar = issues.find((i) => {
      const ageMs = Date.now() - new Date(i.created_at).getTime();
      return i.state === "open" && ageMs < 1000 * 60 * 60 * 24 * 14 && equivalentTitle(i.title, title);
    });
    const existing = marked || similar;
    if (existing) {
      return { html_url: existing.html_url, number: existing.number, title: existing.title, created: false, duplicate: true };
    }
    const issueBody = `${body.trim().slice(0, MAX_ISSUE_BODY)}\n\n${markerFor(key)}`;
    const created = await api<GithubIssue>(`/repos/${slug}/issues`, token, {
      method: "POST",
      body: JSON.stringify({ title: title.slice(0, 180), body: issueBody }),
    });
    return { html_url: created.html_url, number: created.number, title: created.title, created: true, duplicate: false };
  })();
  inFlightIssueCreates.set(operationKey, run);
  try {
    return await run;
  } finally {
    inFlightIssueCreates.delete(operationKey);
  }
}

export async function listIssues(
  repoPath: string,
  slugHint?: string,
  state: "open" | "closed" | "all" = "open"
): Promise<GithubIssue[]> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  const slug = await resolveSlug(repoPath, slugHint);
  const issues = await api<GithubIssue[]>(`/repos/${slug}/issues?state=${state}&sort=updated&direction=desc&per_page=50`, token);
  return issues.filter((i) => !i.pull_request);
}

export async function getIssue(repoPath: string, number: number, slugHint?: string): Promise<GithubIssue> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  const slug = await resolveSlug(repoPath, slugHint);
  const issue = await api<GithubIssue>(`/repos/${slug}/issues/${number}`, token);
  if (issue.pull_request) throw Object.assign(new Error(`#${number} is a pull request, not an issue`), { status: 400 });
  return issue;
}

// ---------- pull requests ----------

export async function defaultBranch(slug: string): Promise<string> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  const details = await api<{ default_branch: string }>(`/repos/${slug}`, token);
  return details.default_branch;
}

export interface PullRequestInfo {
  html_url: string;
  number: number;
  title: string;
}

/** An open Forge PR from `branch`, if one already exists. */
export async function findOpenPullRequest(slug: string, branch: string): Promise<PullRequestInfo | null> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  const owner = slug.split("/")[0];
  const pulls = await api<PullRequestInfo[]>(
    `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    token
  );
  return pulls[0] ?? null;
}

export async function openPullRequest(
  slug: string,
  params: { title: string; head: string; base: string; body: string }
): Promise<PullRequestInfo> {
  const token = await githubToken();
  if (!token) throw noAccessError();
  return api<PullRequestInfo>(`/repos/${slug}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ ...params, title: params.title.slice(0, 180) }),
  });
}

/** Clone URL with the token injected (stripped from the git remote after clone). */
export function tokenizedCloneUrl(url: string, token: string | null): string {
  if (!token) return url;
  return url.replace(/^https:\/\/github\.com\//, `https://x-access-token:${token}@github.com/`);
}
