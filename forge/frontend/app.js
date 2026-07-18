import { Whiteboard } from "./whiteboard.js";

const API = window.FORGE_API || "";
const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const wb = new Whiteboard($("board"));

let stream = null;
let recog = null;
let recogWanted = false;
let ttsSpeaking = false;
let agentBusy = false;
let cancelled = false;
let ccOn = true;
let audioCtx = null;

let currentAudio = null;
let agentAbort = null;

let health = { ok: false, tts: false, llm: "?", repo: { name: "your repo" } };

const transcriptLog = [];   // rolling {who, text} for agent context
let buffer = [];            // passively heard utterances since last hand check
let handRaised = false;
let handReason = "";
let lastListenAt = 0;
let listenTimer = null;
let handTimer = null;

const WAKE = /\b(forge|forge's|archie)\b/i;
const INVITE = /\b(go ahead|go for it|take it away|what do you think|your thoughts|tell us|share it|yes forge|sure forge|floor is yours)\b/i;
const STOP = /\b(stop presenting|back to (the )?grid|that'?s enough|stop talking|be quiet|thanks,? forge|thank you,? forge)\b/i;
const CLEAR = /\b((clear|wipe) the board|start over|clean slate)\b/i;

const CHIPS = [
  "Forge, how does this project itself work?",
  "How does OAuth work?",
  "What happens if we split the backend into services?",
  "Redis vs Kafka for our events?",
];

// ---------- captions / transcript ----------
let capTimer = null;
function caption(speaker, text, sticky = false) {
  if (!ccOn) return;
  $("cap-speaker").textContent = speaker;
  $("cap-text").textContent = text;
  $("captions").classList.add("show");
  clearTimeout(capTimer);
  if (!sticky) capTimer = setTimeout(() => $("captions").classList.remove("show"), 5000);
}

function transcript(who, text) {
  transcriptLog.push({ who, text });
  if (transcriptLog.length > 40) transcriptLog.shift();
  const div = document.createElement("div");
  div.className = "m" + (who === "Forge" ? " agent" : "");
  const whoEl = document.createElement("div");
  whoEl.className = "who";
  whoEl.textContent = who;
  const body = document.createElement("div");
  body.textContent = text;
  div.append(whoEl, body);
  $("msgs").appendChild(div);
  $("msgs").scrollTop = $("msgs").scrollHeight;
}

function setStatus(t) {
  $("agentstatus").textContent = t;
}

// ---------- voice output: ElevenLabs first, browser TTS fallback ----------
let cachedVoice = null;
function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const vs = speechSynthesis.getVoices();
  const prefs = ["Google US English", "Samantha", "Aaron", "Karen"];
  cachedVoice =
    vs.find((v) => prefs.includes(v.name)) ||
    vs.find((v) => v.lang?.startsWith("en") && v.localService) ||
    vs.find((v) => v.lang?.startsWith("en")) ||
    null;
  return cachedVoice;
}
speechSynthesis.onvoiceschanged = () => { cachedVoice = null; };

function browserSpeak(text) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    setTimeout(done, text.split(/\s+/).length * 480 + 3500); // some browsers drop onend
  });
}

async function elevenSpeak(text) {
  const res = await fetch(`${API}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  await new Promise((resolve, reject) => {
    const a = new Audio(url);
    currentAudio = a;
    a.onended = resolve;
    a.onerror = reject;
    a.play().catch(reject);
  }).finally(() => {
    URL.revokeObjectURL(url);
    currentAudio = null;
  });
}

async function speak(text) {
  ttsSpeaking = true;
  stopRecog(); // don't transcribe our own voice
  $("orb").classList.add("speaking");
  try {
    if (!health.tts || cancelled) throw new Error("tts off");
    await elevenSpeak(text);
  } catch {
    if (!cancelled) await browserSpeak(text);
  }
  ttsSpeaking = false;
  $("orb").classList.remove("speaking");
  setTimeout(startRecog, 300);
}

function cancelSpeech() {
  speechSynthesis.cancel();
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
}

// ---------- speech recognition ----------
function buildRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        const text = res[0].transcript.trim();
        if (text) handleUtterance(text, "voice");
      } else if (!ttsSpeaking) {
        caption("You", res[0].transcript);
      }
    }
  };
  r.onend = () => {
    if (recogWanted && !ttsSpeaking) setTimeout(() => { try { r.start(); } catch {} }, 250);
  };
  return r;
}

function startRecog() {
  if (!recog || !recogWanted || ttsSpeaking) return;
  try { recog.start(); } catch {}
}
function stopRecog() {
  try { recog?.abort(); } catch {}
}

// ---------- raise hand ----------
function raiseHand(reason) {
  if (handRaised || agentBusy) return;
  handRaised = true;
  handReason = reason;
  $("hand").classList.remove("hidden");
  setStatus("✋ has a thought");
  chime(0.4);
  clearTimeout(handTimer);
  handTimer = setTimeout(lowerHand, 90_000); // don't hold a stale hand forever
}
function lowerHand() {
  handRaised = false;
  handReason = "";
  $("hand").classList.add("hidden");
  if (!agentBusy) setStatus("listening");
}

function scheduleListenCheck() {
  clearTimeout(listenTimer);
  listenTimer = setTimeout(listenCheck, 2600);
}

async function listenCheck() {
  if (agentBusy || handRaised || ttsSpeaking) return;
  const chars = buffer.reduce((n, l) => n + l.text.length, 0);
  if (chars < 60) return;
  if (Date.now() - lastListenAt < 20_000) { scheduleListenCheck(); return; }
  lastListenAt = Date.now();
  const batch = buffer.slice(-10);
  try {
    const res = await fetch(`${API}/api/listen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: batch }),
    });
    const out = await res.json();
    if (out.raise) raiseHand(out.reason);
  } catch { /* backend hiccup — stay quiet */ }
}

// ---------- the agent ----------
async function runAgent({ question = "", invited = false, reason = "" }) {
  if (agentBusy) return;
  agentBusy = true;
  cancelled = false;
  lowerHand();
  setStatus("thinking…");
  $("thinking").classList.remove("hidden");
  agentAbort = new AbortController();

  let sawStep = false;
  try {
    const res = await fetch(`${API}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: agentAbort.signal,
      body: JSON.stringify({
        question,
        invited,
        reason,
        transcript: transcriptLog.slice(-14),
        board: wb.summary(),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`agent ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "step") continue;
        if (!sawStep) { sawStep = true; $("thinking").classList.add("hidden"); }
        await playStep(msg);
        if (cancelled) { try { reader.cancel(); } catch {} break outer; }
      }
    }
    if (!sawStep && !cancelled) {
      const line = "Hmm, I came up empty on that one — mind rephrasing?";
      caption("Forge", line, true);
      transcript("Forge", line);
      await speak(line);
    }
  } catch (err) {
    if (!cancelled) {
      const line = "I can't reach my backend brain right now — is the server still running?";
      caption("Forge", line, true);
      transcript("Forge", line);
      await speak(line);
    }
  } finally {
    $("thinking").classList.add("hidden");
    $("captions").classList.remove("show");
    setStatus("listening");
    agentBusy = false;
    agentAbort = null;
    buffer = [];
  }
}

async function playStep(step) {
  if (step.ops?.length) {
    if (!$("room").classList.contains("presenting")) {
      enterPresenting();
      chime(1);
    }
    wb.enqueue(step.ops);
  }
  caption("Forge", step.say, true);
  transcript("Forge", step.say);
  setStatus(step.ops?.length ? "presenting" : "speaking");
  await Promise.all([speak(step.say), waitBoardIdle()]);
  if (cancelled) { wb.finishNow(); return; }
  await delay(320);
}

function waitBoardIdle() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!wb.busy || cancelled) resolve();
      else setTimeout(tick, 100);
    };
    tick();
  });
}

function cancelAgent() {
  cancelled = true;
  agentAbort?.abort();
  cancelSpeech();
  wb.finishNow();
  exitPresenting();
  setStatus("listening");
}

// ---------- utterance routing ----------
function handleUtterance(text, source) {
  transcript("You", text);

  if (STOP.test(text)) {
    cancelAgent();
    if (!agentBusy) { caption("Forge", "Sure — back to you."); speak("Sure — back to you."); }
    return;
  }
  if (CLEAR.test(text)) {
    if (agentBusy) return;
    wb.clear();
    caption("Forge", "Board's clean.");
    speak("Board's clean.");
    return;
  }
  if (source === "typed" || WAKE.test(text)) {
    runAgent({ question: text });
    return;
  }
  if (handRaised && INVITE.test(text)) {
    runAgent({ invited: true, reason: handReason });
    return;
  }
  // Not addressed to Forge: listen passively, maybe raise hand.
  buffer.push({ who: "You", text });
  if (buffer.length > 14) buffer.shift();
  scheduleListenCheck();
}

// ---------- presenting / sounds ----------
function enterPresenting() {
  $("room").classList.add("presenting");
}
function exitPresenting() {
  $("room").classList.remove("presenting");
  if (!agentBusy) setStatus("listening");
}

function chime(gain = 1) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [523.25, 783.99].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.06 * gain, t0 + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + i * 0.12);
    o.stop(t0 + i * 0.12 + 0.55);
  });
}

// ---------- mic level → talking ring ----------
function startMeter() {
  if (!stream.getAudioTracks().length) return;
  const src = audioCtx.createMediaStreamSource(stream);
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.frequencyBinCount);
  (function loop() {
    requestAnimationFrame(loop);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / buf.length) / 128;
    const micOn = stream.getAudioTracks()[0]?.enabled;
    $("tile-you").classList.toggle("talking", micOn && rms > 0.045);
  })();
}

// ---------- boot ----------
function placeholderStream() {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#171b22";
  ctx.fillRect(0, 0, 640, 360);
  return c.captureStream(2);
}

async function boot() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    // No cam/mic: still let them join — typed questions keep working.
    stream = placeholderStream();
    $("tile-you")?.classList.add("camoff");
    document.querySelector(".prejoin-hint").textContent = `Camera/mic blocked (${e.name}) — joining without them; use the chat panel.`;
  }
  $("preview").srcObject = stream;
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API}/api/health`);
    health = await res.json();
    $("backend-pill").className = "ok";
    $("backend-pill").title = `backend ok · brain: ${health.llm} · voice: ${health.tts ? "ElevenLabs" : "browser"} · repo: ${health.repo?.name}`;
  } catch {
    health = { ok: false, tts: false, llm: "?", repo: { name: "your repo" } };
    $("backend-pill").className = "err";
    $("backend-pill").title = "backend unreachable — start forge/backend (npm start)";
  }
}

async function join() {
  $("prejoin").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("cam").srcObject = stream;

  audioCtx = new AudioContext();
  startMeter();

  recog = buildRecog();
  recogWanted = true;
  startRecog();
  if (!recog) caption("Forge", "Voice input needs Chrome — use the chat panel to ask me things.", true);

  const tickClock = () => {
    $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  tickClock();
  setInterval(tickClock, 10_000);

  await document.fonts.ready;
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    wb.update(dt);
    wb.render();
  })(last);

  await fetchHealth();
  await delay(500);
  const repoName = health.repo?.name || "your repo";
  const greeting = health.ok
    ? `Hey, I'm Forge. I've read the ${repoName} codebase and I'm following along. Say my name to ask me anything, or just talk — I'll raise my hand when I can help.`
    : `Hey, I'm Forge. My backend isn't reachable, so start the server and reload — then I can really join in.`;
  caption("Forge", greeting, true);
  transcript("Forge", greeting);
  speak(greeting);
}

// ---------- controls ----------
$("joinbtn").addEventListener("click", join, { once: true });

$("btn-mic").addEventListener("click", () => {
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("btn-mic").classList.toggle("off", !track.enabled);
  recogWanted = track.enabled;
  track.enabled ? startRecog() : stopRecog();
});

$("btn-cam").addEventListener("click", () => {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("btn-cam").classList.toggle("off", !track.enabled);
  $("tile-you").classList.toggle("camoff", !track.enabled);
});

$("btn-cc").addEventListener("click", () => {
  ccOn = !ccOn;
  $("btn-cc").classList.toggle("dim", !ccOn);
  if (!ccOn) $("captions").classList.remove("show");
});

$("btn-chat").addEventListener("click", () => $("panel").classList.toggle("open"));
$("panel-close").addEventListener("click", () => $("panel").classList.remove("open"));

$("exitboard").addEventListener("click", cancelAgent);

$("hand").addEventListener("click", () => {
  if (!agentBusy) runAgent({ invited: true, reason: handReason });
});

$("btn-end").addEventListener("click", () => {
  recogWanted = false;
  stopRecog();
  cancelSpeech();
  agentAbort?.abort();
  stream.getTracks().forEach((t) => t.stop());
  $("ended").classList.remove("hidden");
});

// chips + typed questions route through the same handler as speech
for (const q of CHIPS) {
  const b = document.createElement("button");
  b.textContent = q;
  b.addEventListener("click", () => handleUtterance(q, "typed"));
  $("chips").appendChild(b);
}

$("askform").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("askinput").value.trim();
  if (!text) return;
  $("askinput").value = "";
  handleUtterance(text, "typed");
});

boot();

// Demo/debug hook: feed an utterance as if it were heard through the mic
// (handy in loud demo halls: window.forge.hear("we should use redis for this")).
window.forge = { hear: (text) => handleUtterance(text, "voice") };
