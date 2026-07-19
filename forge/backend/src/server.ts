// Forge backend — API + (for local dev) statically serves the frontend.
import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { buildDigest } from "./lib/repo.ts";
import { respond, listen, setRepoContext, getRepoCwd, getRepoSlug, walkthrough, createIssueFlow, implementIssueFlow } from "./lib/agent.ts";
import { synthesize, synthesizeStream, ttsEnabled } from "./lib/tts.ts";
import { llmMode } from "./lib/llm.ts";
import { attachRoom } from "./lib/room.ts";
import * as github from "./lib/github.ts";
import type { AgentRequestBody, RepoMeta, TranscriptLine, WalkthroughRequestBody } from "./lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const execFileP = promisify(execFile);
const REPO_CACHE = join(__dirname, "..", ".repo-cache");

const GITHUB_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

// A repo "source" is either a local path or a GitHub URL (shallow-cloned into
// the cache; pulled on re-load). Returns the local path to index.
async function ensureRepo(source: string): Promise<string> {
  const m = source.match(GITHUB_URL_RE);
  if (!m) return resolve(source);
  // Cache key includes the owner so acme/api and globex/api don't collide.
  const dir = join(REPO_CACHE, `${m[1]}__${m[2]}`);
  const token = await github.githubToken();
  if (existsSync(join(dir, ".git"))) {
    // Pull through the tokenized URL so private repos refresh too (the stored
    // remote is intentionally token-free).
    await execFileP("git", ["-C", dir, "pull", "--ff-only", github.tokenizedCloneUrl(source, token)], { timeout: 30_000 }).catch(() => {});
  } else {
    // Token in the URL enables private repos; the remote is reset afterwards
    // so the token never persists on disk.
    await execFileP("git", ["clone", "--depth", "1", github.tokenizedCloneUrl(source, token), dir], { timeout: 120_000 });
    await execFileP("git", ["-C", dir, "remote", "set-url", "origin", source], { timeout: 5000 }).catch(() => {});
  }
  return dir;
}

// src/server.ts -> src -> backend -> forge -> repo root (three levels up).
const REPO_SOURCE = process.env.REPO_PATH || process.env.GITHUB_REPO || join(__dirname, "..", "..", "..");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The static app remains public so invitees can load it, but every API and
// WebSocket request requires the fragment-derived invite token when configured.
app.use("/api", (req, res, next) => {
  const expectedToken = process.env.FORGE_ACCESS_TOKEN;
  if (!expectedToken || tokenMatches(req.header("X-Forge-Access-Token"), expectedToken)) return next();
  res.status(401).json({ error: "invalid Forge invite" });
});

let repoMeta: RepoMeta = { name: "(indexing…)", fileCount: 0 };
// owner/repo of the active repository — known from the load URL, or derived
// from the checkout's git origin. Used for issue creation and GitHub links.
let repoSlug: string | null = null;

// Index a repo source and make it the active repo for the whole backend.
async function loadRepo(source: string): Promise<RepoMeta> {
  const path = await ensureRepo(source);
  const m = source.match(GITHUB_URL_RE);
  repoSlug = m ? `${m[1]}/${m[2]}` : (await github.repoSlugFor(path)) || github.configuredRepoSlug();
  const { digest, meta } = await buildDigest(path);
  setRepoContext(digest, path, repoSlug);
  repoMeta = meta;
  return meta;
}

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, llm: llmMode(), tts: ttsEnabled(), repo: repoMeta });
});

app.post("/api/agent", (req: Request, res: Response) => respond(req.body as AgentRequestBody, res));

app.post("/api/listen", async (req: Request, res: Response) => res.json(await listen(req.body as AgentRequestBody)));

// GitHub access is configured once with GITHUB_TOKEN in the backend environment.
app.get("/api/github/status", async (_req: Request, res: Response) => {
  res.json(await github.status());
});

app.get("/api/github/repos", async (req: Request, res: Response) => {
  try {
    res.json(await github.listRepos());
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

// Streamed NDJSON: research progress → the created (or reused) issue.
// When the frontend passes the raw spoken command, Claude explores the repo
// with tools and writes the issue; a dedupe layer guarantees one issue per
// intent even across retries and repeated speech finals.
app.post("/api/github/issues", (req: Request, res: Response) =>
  createIssueFlow(req.body as { command?: string; title?: string; body?: string; transcript?: TranscriptLine[]; idempotencyKey?: string } ?? {}, res)
);

/** Read the active repository's GitHub issues without exposing its token. */
app.get("/api/github/issues", async (req: Request, res: Response) => {
  const cwd = getRepoCwd();
  if (!cwd) return res.status(400).json({ error: "no repo loaded" });
  const state = req.query.state === "closed" || req.query.state === "all" ? req.query.state : "open";
  try {
    res.json(await github.listIssues(cwd, getRepoSlug(), state));
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

app.get("/api/github/issues/:number", async (req: Request, res: Response) => {
  const cwd = getRepoCwd();
  const number = Number(req.params.number);
  if (!cwd) return res.status(400).json({ error: "no repo loaded" });
  if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: "invalid issue number" });
  try {
    res.json(await github.getIssue(cwd, number, getRepoSlug()));
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

/**
 * Streamed NDJSON: reads the issue, implements it in an isolated worktree,
 * validates, pushes forge/issue-<n>-* and opens a pull request.
 */
app.post("/api/github/issues/:number/implement", (req: Request, res: Response) => {
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: "invalid issue number" });
  return implementIssueFlow(number, res);
});

// Point Forge at a different repo mid-meeting: local path or GitHub URL.
app.post("/api/repo/load", async (req: Request, res: Response) => {
  const source = String((req.body as { url?: string } | undefined)?.url || "").trim();
  if (!source) return res.status(400).json({ error: "no url" });
  try {
    const meta = await loadRepo(source);
    console.log(`repo switched → ${meta.name} (${meta.fileCount} files)`);
    res.json({ ok: true, repo: meta });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/tts/stream", async (req: Request, res: Response) => {
  const body = req.body as { text?: string } | undefined;
  const text = String(body?.text || "").slice(0, 900);
  if (!text) return res.status(400).json({ error: "no text" });
  try {
    const upstream = await synthesizeStream(text);
    res.set("Content-Type", "audio/mpeg");
    const reader = upstream.body!.getReader();
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
      }
    };
    res.on("close", () => reader.cancel());
    await pump();
  } catch (err) {
    const status = (err as { status?: number }).status || 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/tts", async (req: Request, res: Response) => {
  const body = req.body as { text?: string } | undefined;
  const text = String(body?.text || "").slice(0, 900);
  if (!text) return res.status(400).json({ error: "no text" });
  try {
    const audio = await synthesize(text);
    res.set("Content-Type", "audio/mpeg").send(audio);
  } catch (err) {
    const status = (err as { status?: number })?.status || 502;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
  }
});

app.get("/api/repo/file", (req: Request, res: Response) => {
  const filePath = String(req.query.path || "").trim();
  const startLine = Math.max(1, parseInt(String(req.query.start || "1"), 10));
  const endLine = parseInt(String(req.query.end || "0"), 10) || undefined;
  const cwd = getRepoCwd();
  if (!filePath || !cwd) return res.status(400).json({ error: "no path or repo" });
  const abs = resolve(cwd, filePath);
  // Security: path must stay inside the repo.
  if (!abs.startsWith(resolve(cwd) + "/") && abs !== resolve(cwd)) return res.status(403).json({ error: "path escape" });
  if (!existsSync(abs)) return res.status(404).json({ error: "not found" });
  const allLines = readFileSync(abs, "utf8").split("\n");
  const from = startLine - 1;
  // Cap the window so a bad request can't ship a whole generated file.
  const to = Math.min(allLines.length, endLine ? endLine : from + 80, from + 400);
  const lines = allLines.slice(from, to);
  let githubUrl: string | undefined;
  if (repoSlug) {
    let branch = "main";
    try {
      branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() || "main";
    } catch { /* not a git checkout — assume default branch */ }
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    githubUrl = `https://github.com/${repoSlug}/blob/${branch}/${rel}#L${startLine}${endLine ? `-L${endLine}` : ""}`;
  }
  res.json({ path: filePath, startLine, lines, githubUrl });
});

app.post("/api/agent/walkthrough", (req: Request, res: Response) =>
  walkthrough(req.body as WalkthroughRequestBody, res)
);

// Local dev convenience: one port serves everything. In a split deployment the
// frontend is hosted statically and points at this API via config.js.
// Prefer a React production build (../frontend/dist) when present — falls
// back to the legacy static ../frontend otherwise.
const distDir = join(__dirname, "..", "..", "frontend", "dist");
const staticDir = existsSync(distDir) ? distDir : join(__dirname, "..", "..", "frontend");
// Hashed assets are immutable; index.html must always revalidate. Without
// this, a browser keeps a cached index.html across a redeploy and requests
// asset hashes that no longer exist on the server.
app.use(express.static(staticDir, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${sep}assets${sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    else res.setHeader("Cache-Control", "no-cache");
  },
}));
// A missing hashed asset must be a plain-text 404 — Express's default HTML
// 404 page (or an SPA fallback) would hand the browser text/html for a
// .css/.js request, which strict MIME checking refuses to apply.
app.get("/assets/*", (_req: Request, res: Response) => {
  res.status(404).type("text/plain").send("asset not found — reload the page to pick up the latest build");
});
// SPA fallback for every non-API route (deep links, stale tabs).
app.get("*", (req: Request, res: Response, next: () => void) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(join(staticDir, "index.html"));
});

const httpServer = app.listen(PORT, async () => {
  console.log(`forge backend → http://localhost:${PORT}`);
  console.log(`  llm: ${llmMode()}${ttsEnabled() ? ", elevenlabs: on" : ", elevenlabs: OFF (browser TTS fallback)"}`);
  console.log(`  indexing repo: ${REPO_SOURCE}`);
  const meta = await loadRepo(REPO_SOURCE);
  console.log(`  repo indexed: ${meta.fileCount} files, ${meta.includedFiles} in digest (${meta.chars} chars)${repoSlug ? ` · github: ${repoSlug}` : ""}`);
});

attachRoom(httpServer);
