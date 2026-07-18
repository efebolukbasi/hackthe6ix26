// Forge backend — API + (for local dev) statically serves the frontend.
import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildDigest } from "./lib/repo.ts";
import { respond, listen, setRepoContext } from "./lib/agent.ts";
import { synthesize, ttsEnabled } from "./lib/tts.ts";
import { llmMode } from "./lib/llm.ts";
import { attachRoom } from "./lib/room.ts";
import type { AgentRequestBody, RepoMeta } from "./lib/types.ts";

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
  if (existsSync(join(dir, ".git"))) {
    await execFileP("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30_000 }).catch(() => {});
  } else {
    await execFileP("git", ["clone", "--depth", "1", source, dir], { timeout: 120_000 });
  }
  return dir;
}

// src/server.ts -> src -> backend -> forge -> repo root (three levels up).
const REPO_SOURCE = process.env.REPO_PATH || process.env.GITHUB_REPO || join(__dirname, "..", "..", "..");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let repoMeta: RepoMeta = { name: "(indexing…)", fileCount: 0 };

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, llm: llmMode(), tts: ttsEnabled(), repo: repoMeta });
});

app.post("/api/agent", (req: Request, res: Response) => respond(req.body as AgentRequestBody, res));

app.post("/api/listen", async (req: Request, res: Response) => res.json(await listen(req.body as AgentRequestBody)));

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
