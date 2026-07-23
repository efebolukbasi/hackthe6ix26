// ElevenLabs TTS engine: disk cache + in-flight coalescing + prewarm.
// Every unique line is synthesized upstream AT MOST once no matter how many
// participants ask for it (a mesh room requests the same line N times at
// once) — subscribers replay the chunks already received, then follow live.
// Identical lines across meetings (greetings, acks, fallbacks) cost credits
// only once, ever. No key → 503 → frontend browser TTS.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/lib/tts.ts, so two levels up from its own directory
// (lib -> src -> backend) lands at forge/backend/.tts-cache, matching the
// original lib/tts.js which was one level up from forge/backend/lib.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".tts-cache");
const DEFAULT_VOICE = "DXFkLCBUTmvXpp2QwZjA"; // Forge's selected ElevenLabs voice
const MODEL = "eleven_flash_v2_5"; // fastest + half-price credits

// Upstream discipline: a wedged ElevenLabs call must never wedge a meeting.
const TTFB_MS = 7_000; // response headers must arrive within this
const CHUNK_GAP_MS = 5_000; // then audio bytes must keep flowing
const TOTAL_MS = 30_000; // absolute cap per synthesis
const RETRY_DELAY_MS = 350; // one retry on 429/5xx/network before any byte is out

export function ttsEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export interface TtsError extends Error {
  status?: number;
}

function ttsError(message: string, status: number): TtsError {
  const e: TtsError = new Error(message);
  e.status = status;
  return e;
}

/** Pronunciation + cleanup applied to the synthesized voice. Mirrors
 * ttsText() in frontend/src/lib/session.ts (which still feeds the browser-TTS
 * fallback and the self-echo filter) — keep the two in sync, or prewarmed
 * cache entries stop matching what clients request. */
export function pronounceForTts(text: string): string {
  return text
    .replace(/\bEfe\b/gi, "F-e")
    .replace(/\bVite\b/gi, "veet")
    .replace(/\bNDJSON\b/gi, "N D jason")
    .replace(/\bAPIs\b/gi, "A P Is")
    .replace(/\bAPI\b/gi, "A P I")
    // "read/grep/list" speaks as a list, not "slash"
    .replace(/(\w) ?\/ ?(?=\w)/g, "$1, ")
    // markdown/markup residue and stray escapes never reach the voice
    .replace(/[\\*_`#|~<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One upstream synthesis, shared by every subscriber. Chunks accumulate so
 * a subscriber that joins mid-flight replays the start, then follows live. */
export class TtsJob {
  readonly chunks: Buffer[] = [];
  done = false;
  error: TtsError | null = null;
  private waiters: Array<() => void> = [];

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.wake();
  }

  finish(error: TtsError | null): void {
    if (this.done) return;
    this.error = error;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiters.splice(0);
    for (const r of w) r();
  }

  private next(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  /** Replay the chunks received so far, then follow the live stream. */
  async *stream(): AsyncGenerator<Buffer> {
    let i = 0;
    for (;;) {
      while (i < this.chunks.length) yield this.chunks[i++];
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await this.next();
    }
  }

  async buffer(): Promise<Buffer> {
    while (!this.done) await this.next();
    if (this.error) throw this.error;
    return Buffer.concat(this.chunks);
  }
}

const inflight = new Map<string, TtsJob>();

function cachePath(hash: string): string {
  return join(CACHE_DIR, `${hash}.mp3`);
}

/** Cache/coalesce front door: cached audio when it's on disk, otherwise the
 * (possibly brand-new) shared in-flight job. Throws a TtsError otherwise. */
export function openTts(rawText: string): { cached?: Buffer; job?: TtsJob } {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw ttsError("no ElevenLabs key", 503);
  const text = pronounceForTts(rawText);
  if (!text) throw ttsError("no speakable text", 400);
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  // Language is part of the cache key: entries synthesized before the
  // language was pinned may be auto-detected wrong and must not replay.
  const hash = createHash("sha1").update(`${voice}|${MODEL}|en|${text}`).digest("hex");
  try {
    const file = cachePath(hash);
    if (existsSync(file)) return { cached: readFileSync(file) };
  } catch {
    /* unreadable cache entry — synthesize fresh */
  }
  let job = inflight.get(hash);
  if (!job) {
    job = new TtsJob();
    inflight.set(hash, job);
    void runJob(job, text, voice, hash);
  }
  return { job };
}

/** Buffered synthesis (cache → coalesced job → full audio). */
export async function synthesize(rawText: string): Promise<Buffer> {
  const { cached, job } = openTts(rawText);
  return cached ?? job!.buffer();
}

async function runJob(job: TtsJob, text: string, voice: string, hash: string): Promise<void> {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchIntoJob(job, text, voice);
        break;
      } catch (err) {
        // Statuses here are already client-facing: 503 means a bad/missing
        // key (never heals in 350ms — don't retry); 429/502/504/network are
        // the transient ones worth one more shot.
        const status = (err as TtsError).status ?? 0;
        const retryable = status === 429 || status === 502 || status === 504 || status === 0;
        // Chunks already fanned out to subscribers can't be unsent — a retry
        // is only safe while the stream hasn't produced anything yet.
        if (attempt === 0 && retryable && job.chunks.length === 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw err;
      }
    }
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath(hash), Buffer.concat(job.chunks));
    } catch {
      /* cache is best-effort */
    }
    job.finish(null);
  } catch (err) {
    const e = err instanceof Error ? (err as TtsError) : ttsError(String(err), 502);
    e.status = e.status ?? 502;
    job.finish(e);
  } finally {
    inflight.delete(hash);
  }
}

async function fetchIntoJob(job: TtsJob, text: string, voice: string): Promise<void> {
  const ctrl = new AbortController();
  let gapTimer = setTimeout(() => ctrl.abort(), TTFB_MS);
  const hardCap = setTimeout(() => ctrl.abort(), TOTAL_MS);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_22050_32`,
      {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          // Flash v2.5 auto-detects language per request; odd tokens (NDJSON,
          // paths) can flip it and English comes out as foreign-phoneme babble.
          language_code: "en",
          voice_settings: { stability: 0.45, similarity_boost: 0.7, speed: 1.04 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw ttsError(`ElevenLabs ${res.status}: ${detail}`, res.status === 401 ? 503 : res.status === 429 ? 429 : 502);
    }
    if (!res.body) throw ttsError("ElevenLabs returned no body", 502);
    const reader = res.body.getReader();
    for (;;) {
      clearTimeout(gapTimer);
      gapTimer = setTimeout(() => ctrl.abort(), CHUNK_GAP_MS);
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) job.push(Buffer.from(value));
    }
    if (!job.chunks.length) throw ttsError("ElevenLabs returned empty audio", 502);
  } catch (err) {
    if (ctrl.signal.aborted) throw ttsError("ElevenLabs timed out", 504);
    throw err;
  } finally {
    clearTimeout(gapTimer);
    clearTimeout(hardCap);
  }
}

// ---------- prewarm ----------
// The agent knows every "say" line well before the client asks to hear it
// (steps are buffered until "done", then gated behind the ready pause).
// Prewarming during LLM streaming means the audio is already on disk when
// playback starts — dead air between steps drops to ~zero. Capped so a burst
// of steps can't starve live requests of ElevenLabs concurrency slots.
const PREWARM_CONCURRENCY = 2;
const PREWARM_QUEUE_MAX = 16;
const prewarmQueue: string[] = [];
const prewarmQueued = new Set<string>();
let prewarmActive = 0;

export function prewarm(text: string): void {
  if (!ttsEnabled()) return;
  const t = String(text || "").slice(0, 900).trim();
  if (!t || prewarmQueued.has(t) || prewarmQueue.length >= PREWARM_QUEUE_MAX) return;
  prewarmQueued.add(t);
  prewarmQueue.push(t);
  drainPrewarm();
}

function drainPrewarm(): void {
  while (prewarmActive < PREWARM_CONCURRENCY && prewarmQueue.length) {
    const t = prewarmQueue.shift()!;
    prewarmActive++;
    void synthesize(t)
      .catch(() => {
        /* best-effort — a live request retries on its own */
      })
      .finally(() => {
        prewarmActive--;
        prewarmQueued.delete(t);
        drainPrewarm();
      });
  }
}
