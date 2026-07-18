// Forge backend — API + (for local dev) statically serves the frontend.
import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { buildDigest } from "./lib/repo.ts";
import { respond, listen, setRepoContext, getRepoCwd, walkthrough } from "./lib/agent.ts";
import { synthesize, synthesizeStream, ttsEnabled } from "./lib/tts.ts";
import { llmMode } from "./lib/llm.ts";
import { attachRoom } from "./lib/room.ts";
import * as github from "./lib/github.ts";
import type { AgentRequestBody, RepoMeta, WalkthroughRequestBody } from "./lib/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const execFileP = promisify(execFile);
const REPO_CACHE = join(__dirname, "..", ".repo-cache");

// A repo "source" is either a local path or a GitHub URL (shallow-cloned into
// the cache; pulled on re-load). Returns the local path to index.
async function ensureRepo(source: string): Promise<string> {
  const m = source.match(/^https:\/\/github\.com\/[\w.-]+\/([\w.-]+?)(\.git)?\/?$/);
  if (!m) return resolve(source);
  const dir = join(REPO_CACHE, m[1]);
  const token = await github.githubToken();
  if (existsSync(join(dir, ".git"))) {
    await execFileP("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30_000 }).catch(() => {});
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

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, llm: llmMode(), tts: ttsEnabled(), repo: repoMeta });
});

app.post("/api/agent", (req: Request, res: Response) => respond(req.body as AgentRequestBody, res));

app.post("/api/listen", async (req: Request, res: Response) => res.json(await listen(req.body as AgentRequestBody)));

// GitHub login: zero-click via env token or the host's `gh` CLI, else device flow.
app.get("/api/github/status", async (_req: Request, res: Response) => res.json(await github.status()));

app.get("/api/github/repos", async (_req: Request, res: Response) => {
  try {
    res.json(await github.listRepos());
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

app.post("/api/github/device/start", async (_req: Request, res: Response) => {
  try {
    const d = await github.deviceStart();
    res.json({ user_code: d.user_code, verification_uri: d.verification_uri, device_code: d.device_code, interval: d.interval });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

app.post("/api/github/device/poll", async (req: Request, res: Response) => {
  const device_code = String((req.body as { device_code?: string } | undefined)?.device_code || "");
  if (!device_code) return res.status(400).json({ error: "no device_code" });
  res.json(await github.devicePoll(device_code));
});

app.post("/api/github/issues", async (req: Request, res: Response) => {
  const body = req.body as { title?: string; body?: string } | undefined;
  const cwd = getRepoCwd();
  if (!cwd) return res.status(400).json({ error: "no repo loaded" });
  const title = String(body?.title || "Meeting follow-up").trim();
  const issueBody = String(body?.body || "Created from a Forge meeting.").trim();
  try {
    res.json(await github.createIssue(cwd, title, issueBody));
  } catch (err) {
    const e = err as { status?: number; message?: string };
    res.status(e.status || 502).json({ error: e.message || String(err) });
  }
});

// Point Forge at a different repo mid-meeting: local path or GitHub URL.
app.post("/api/repo/load", async (req: Request, res: Response) => {
  const source = String((req.body as { url?: string } | undefined)?.url || "").trim();
  if (!source) return res.status(400).json({ error: "no url" });
  try {
    const path = await ensureRepo(source);
    const { digest, meta } = await buildDigest(path);
    setRepoContext(digest, path);
    repoMeta = meta;
    console.log(`repo switched → ${path} (${meta.fileCount} files)`);
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
  const to = endLine ? endLine : Math.min(allLines.length, from + 80);
  const lines = allLines.slice(from, to);
  let githubUrl: string | undefined;
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const m = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/);
    if (m) {
      const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
      const rel = relative(cwd, abs).replace(/\\/g, "/");
      githubUrl = `https://github.com/${m[1]}/blob/${branch}/${rel}#L${startLine}${endLine ? `-L${endLine}` : ""}`;
    }
  } catch { /* no git or no remote */ }
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
app.use(express.static(staticDir));

const httpServer = app.listen(PORT, async () => {
  console.log(`forge backend → http://localhost:${PORT}`);
  console.log(`  llm: ${llmMode()}${ttsEnabled() ? ", elevenlabs: on" : ", elevenlabs: OFF (browser TTS fallback)"}`);
  console.log(`  indexing repo: ${REPO_SOURCE}`);
  const repoPath = await ensureRepo(REPO_SOURCE);
  const { digest, meta } = await buildDigest(repoPath);
  setRepoContext(digest, repoPath);
  repoMeta = meta;
  console.log(`  repo indexed: ${meta.fileCount} files, ${meta.includedFiles} in digest (${meta.chars} chars)`);
});

attachRoom(httpServer);
