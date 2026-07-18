// Forge backend — API + (for local dev) statically serves the frontend.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDigest } from "./lib/repo.js";
import { respond, listen, setRepoDigest } from "./lib/agent.js";
import { synthesize, ttsEnabled } from "./lib/tts.js";
import { llmMode } from "./lib/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const REPO_PATH = resolve(process.env.REPO_PATH || join(__dirname, "..", ".."));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let repoMeta = { name: "(indexing…)", fileCount: 0 };

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, llm: llmMode(), tts: ttsEnabled(), repo: repoMeta });
});

app.post("/api/agent", (req, res) => respond(req.body, res));

app.post("/api/listen", async (req, res) => res.json(await listen(req.body)));

app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 900);
  if (!text) return res.status(400).json({ error: "no text" });
  try {
    const audio = await synthesize(text);
    res.set("Content-Type", "audio/mpeg").send(audio);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Local dev convenience: one port serves everything. In a split deployment the
// frontend is hosted statically and points at this API via config.js.
app.use(express.static(join(__dirname, "..", "frontend")));

app.listen(PORT, async () => {
  console.log(`forge backend → http://localhost:${PORT}`);
  console.log(`  llm: ${llmMode()}${ttsEnabled() ? ", elevenlabs: on" : ", elevenlabs: OFF (browser TTS fallback)"}`);
  console.log(`  indexing repo: ${REPO_PATH}`);
  const { digest, meta } = await buildDigest(REPO_PATH);
  setRepoDigest(digest);
  repoMeta = meta;
  console.log(`  repo indexed: ${meta.fileCount} files, ${meta.includedFiles} in digest (${meta.chars} chars)`);
});
