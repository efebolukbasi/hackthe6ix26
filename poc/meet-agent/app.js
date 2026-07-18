import { Whiteboard } from "./whiteboard.js";
import { GREETING, DEFAULT_REPLY, CHIPS, interpret } from "./brain.js";

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const wb = new Whiteboard($("board"));

let stream = null;
let recog = null;
let recogWanted = false;   // mic on + not ended
let ttsSpeaking = false;
let agentBusy = false;
let cancelled = false;
let boardTopic = null;
let ccOn = true;
let audioCtx = null;

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
  const div = document.createElement("div");
  div.className = "m" + (who === "Archie" ? " agent" : "");
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

// ---------- TTS ----------
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

function speak(text) {
  return new Promise((resolve) => {
    ttsSpeaking = true;
    stopRecog(); // don't transcribe our own voice
    $("orb").classList.add("speaking");
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      ttsSpeaking = false;
      $("orb").classList.remove("speaking");
      setTimeout(startRecog, 300);
      resolve();
    };
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    // safety net: some browsers drop onend
    setTimeout(done, text.split(/\s+/).length * 480 + 3500);
  });
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
        if (text) handleUtterance(text);
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

// ---------- the agent ----------
async function handleUtterance(text) {
  transcript("You", text);
  const intent = interpret(text, boardTopic);
  if (!intent) return;

  if (intent.type === "stop") {
    cancelled = true;
    speechSynthesis.cancel();
    exitPresenting();
    if (!agentBusy) { caption("Archie", "Sure — back to you."); speak("Sure — back to you."); }
    return;
  }
  if (intent.type === "clear") {
    if (agentBusy) return;
    wb.clear();
    boardTopic = null;
    caption("Archie", "Board's clean.");
    speak("Board's clean.");
    return;
  }
  if (agentBusy) return;
  if (intent.type === "default") {
    caption("Archie", DEFAULT_REPLY, true);
    transcript("Archie", DEFAULT_REPLY);
    await speak(DEFAULT_REPLY);
    return;
  }
  if (intent.type === "topic") runTopic(intent.topic);
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

async function runTopic(topic) {
  agentBusy = true;
  cancelled = false;

  setStatus("thinking…");
  $("thinking").classList.remove("hidden");
  await delay(900);
  $("thinking").classList.add("hidden");

  enterPresenting();
  chime();
  if (topic.fresh) wb.clear();
  boardTopic = topic.board;
  setStatus("presenting");

  for (const step of topic.steps) {
    if (cancelled) break;
    caption("Archie", step.say, true);
    transcript("Archie", step.say);
    if (step.ops?.length) wb.enqueue(step.ops);
    await Promise.all([speak(step.say), waitBoardIdle()]);
    if (cancelled) { wb.finishNow(); break; }
    await delay(380);
  }

  $("captions").classList.remove("show");
  setStatus("listening");
  agentBusy = false;
}

function enterPresenting() {
  $("room").classList.add("presenting");
}
function exitPresenting() {
  $("room").classList.remove("presenting");
  setStatus("listening");
}

function chime() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [523.25, 783.99].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + i * 0.12);
    o.stop(t0 + i * 0.12 + 0.55);
  });
}

// ---------- mic level → talking ring ----------
function startMeter() {
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
async function boot() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    document.querySelector(".prejoin-hint").textContent = `Camera/mic blocked (${e.name}) — allow access and reload.`;
    return;
  }
  $("preview").srcObject = stream;
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
  if (!recog) caption("Archie", "Voice input needs Chrome — use the chat panel to ask me things.", true);

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

  await delay(700);
  caption("Archie", GREETING, true);
  transcript("Archie", GREETING);
  speak(GREETING);
}

// ---------- controls ----------
$("joinbtn").addEventListener("click", join);

$("btn-mic").addEventListener("click", () => {
  const track = stream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $("btn-mic").classList.toggle("off", !track.enabled);
  recogWanted = track.enabled;
  track.enabled ? startRecog() : stopRecog();
});

$("btn-cam").addEventListener("click", () => {
  const track = stream.getVideoTracks()[0];
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

$("exitboard").addEventListener("click", () => {
  cancelled = true;
  speechSynthesis.cancel();
  exitPresenting();
});

$("btn-end").addEventListener("click", () => {
  recogWanted = false;
  stopRecog();
  speechSynthesis.cancel();
  stream.getTracks().forEach((t) => t.stop());
  $("ended").classList.remove("hidden");
});

// chips + typed questions route through the same handler as speech
for (const q of CHIPS) {
  const b = document.createElement("button");
  b.textContent = q;
  b.addEventListener("click", () => handleUtterance(q));
  $("chips").appendChild(b);
}

$("askform").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("askinput").value.trim();
  if (!text) return;
  $("askinput").value = "";
  handleUtterance(text);
});

boot();
