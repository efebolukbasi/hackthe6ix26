// ElevenLabs TTS proxy with a disk cache (identical lines — greetings,
// fallbacks — cost credits only once). No key → 503 → frontend browser TTS.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/lib/tts.ts, so two levels up from its own directory
// (lib -> src -> backend) lands at forge/backend/.tts-cache, matching the
// original lib/tts.js which was one level up from forge/backend/lib.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".tts-cache");
const DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"; // Adam
const MODEL = "eleven_flash_v2_5"; // fastest + half-price credits

export function ttsEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

interface TtsError extends Error {
  status?: number;
}

export async function synthesize(text: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    const e: TtsError = new Error("no ElevenLabs key");
    e.status = 503;
    throw e;
  }

  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const hash = createHash("sha1").update(`${voice}|${MODEL}|${text}`).digest("hex");
  const cached = join(CACHE_DIR, `${hash}.mp3`);
  if (existsSync(cached)) return readFileSync(cached);

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_22050_32`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.7, speed: 1.04 },
    }),
  });
  if (!res.ok) {
    const e: TtsError = new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    e.status = res.status === 401 ? 503 : 502;
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, buf);
  } catch {
    /* cache is best-effort */
  }
  return buf;
}
