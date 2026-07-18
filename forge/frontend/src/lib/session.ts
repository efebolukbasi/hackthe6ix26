// ForgeSession: all imperative call logic, framework-free. Owns the media
// stream, speech recognition, AudioContext (chime + mic meter), TTS playback
// (ElevenLabs fetch → Audio, browser speechSynthesis fallback), the /api/agent
// NDJSON reader loop with sequential step playback, and the passive listen
// buffer + raise-hand logic. UI state is pushed into the zustand store.

import { Whiteboard } from "./whiteboard";
import { RoomLink, type CastEvent } from "./rtc";
import { API } from "../config";
import { useStore } from "../state/store";
import type {
  AgentStep,
  Health,
  SpeechRecognitionLike,
  StreamMsg,
  TranscriptLine,
} from "../types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const WAKE = /\b(forge|forge's|archie)\b/i;
const INVITE = /\b(go ahead|go for it|take it away|what do you think|your thoughts|tell us|share it|yes forge|sure forge|floor is yours)\b/i;
const STOP = /\b(stop presenting|back to (the )?grid|that'?s enough|stop talking|be quiet|thanks,? forge|thank you,? forge)\b/i;
const CLEAR = /\b((clear|wipe) the board|start over|clean slate)\b/i;

export const CHIPS = [
  "Forge, how does this project itself work?",
  "How does OAuth work?",
  "What happens if we split the backend into services?",
  "Redis vs Kafka for our events?",
];

type UtteranceSource = "voice" | "typed";

export class ForgeSession {
  wb: Whiteboard | null = null;
  stream: MediaStream | null = null;

  private recog: SpeechRecognitionLike | null = null;
  private recogWanted = false;
  private ttsSpeaking = false;
  private agentBusy = false;
  private cancelled = false;
  private audioCtx: AudioContext | null = null;

  private currentAudio: HTMLAudioElement | null = null;
  private agentAbort: AbortController | null = null;

  private health: Health = { ok: false, tts: false, llm: "?", repo: { name: "your repo" } };

  private buffer: TranscriptLine[] = []; // passively heard utterances since last hand check
  private handReason = "";
  private lastListenAt = 0;
  private listenTimer: ReturnType<typeof setTimeout> | undefined;
  private handTimer: ReturnType<typeof setTimeout> | undefined;
  private capTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedVoice: SpeechSynthesisVoice | null = null;
  private booted = false;
  private joined = false;

  private room: RoomLink | null = null;
  private remoteAgentActive = false;
  private remoteChain: Promise<void> = Promise.resolve();
  private myName = "You";

  constructor() {
    // Demo/debug hook: feed an utterance as if it were heard through the mic
    // (handy in loud demo halls: window.forge.hear("we should use redis for this")).
    window.forge = { hear: (text: string) => this.handleUtterance(text, "voice") };
    speechSynthesis.onvoiceschanged = () => { this.cachedVoice = null; };
  }

  private get handRaised(): boolean {
    return useStore.getState().handRaised;
  }

  // ---------- captions / transcript ----------
  private caption(speaker: string, text: string, sticky = false): void {
    if (!useStore.getState().ccOn) return;
    useStore.setState({ caption: { speaker, text, visible: true } });
    clearTimeout(this.capTimer);
    if (!sticky) this.capTimer = setTimeout(() => this.hideCaption(), 5000);
  }

  private hideCaption(): void {
    useStore.setState((s) => ({ caption: { ...s.caption, visible: false } }));
  }

  private transcript(who: string, text: string): void {
    useStore.setState((s) => ({ transcript: [...s.transcript, { who, text }] }));
  }

  private setStatus(t: string): void {
    useStore.setState({ agentStatus: t });
  }

  // ---------- voice output: ElevenLabs first, browser TTS fallback ----------
  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.cachedVoice) return this.cachedVoice;
    const vs = speechSynthesis.getVoices();
    const prefs = ["Google US English", "Samantha", "Aaron", "Karen"];
    this.cachedVoice =
      vs.find((v) => prefs.includes(v.name)) ||
      vs.find((v) => v.lang?.startsWith("en") && v.localService) ||
      vs.find((v) => v.lang?.startsWith("en")) ||
      null;
    return this.cachedVoice;
  }

  private browserSpeak(text: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.rate = 1.04;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      setTimeout(done, text.split(/\s+/).length * 480 + 3500); // some browsers drop onend
    });
  }

  private async elevenSpeak(text: string): Promise<void> {
    const res = await fetch(`${API}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    await new Promise<void>((resolve, reject) => {
      const a = new Audio(url);
      this.currentAudio = a;
      a.onended = () => resolve();
      a.onerror = reject;
      a.play().catch(reject);
    }).finally(() => {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
    });
  }

  private async speak(text: string): Promise<void> {
    this.ttsSpeaking = true;
    this.stopRecog(); // don't transcribe our own voice
    useStore.setState({ orbSpeaking: true });
    try {
      if (!this.health.tts || this.cancelled) throw new Error("tts off");
      await this.elevenSpeak(text);
    } catch {
      if (!this.cancelled) await this.browserSpeak(text);
    }
    this.ttsSpeaking = false;
    useStore.setState({ orbSpeaking: false });
    setTimeout(() => this.startRecog(), 300);
  }

  private cancelSpeech(): void {
    speechSynthesis.cancel();
    if (this.currentAudio) { try { this.currentAudio.pause(); } catch { /* noop */ } this.currentAudio = null; }
  }

  // ---------- speech recognition ----------
  private buildRecog(): SpeechRecognitionLike | null {
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
          if (text) this.handleUtterance(text, "voice");
        } else if (!this.ttsSpeaking) {
          this.caption("You", res[0].transcript);
        }
      }
    };
    r.onend = () => {
      if (this.recogWanted && !this.ttsSpeaking) setTimeout(() => { try { r.start(); } catch { /* already started */ } }, 250);
    };
    return r;
  }

  private startRecog(): void {
    if (!this.recog || !this.recogWanted || this.ttsSpeaking) return;
    try { this.recog.start(); } catch { /* already started */ }
  }

  private stopRecog(): void {
    try { this.recog?.abort(); } catch { /* noop */ }
  }

  // ---------- raise hand ----------
  private raiseHand(reason: string): void {
    if (this.handRaised || this.agentBusy) return;
    this.handReason = reason;
    useStore.setState({ handRaised: true });
    this.setStatus("✋ has a thought");
    this.chime(0.4);
    this.room?.cast({ k: "hand", raised: true, reason });
    clearTimeout(this.handTimer);
    this.handTimer = setTimeout(() => this.lowerHand(), 90_000); // don't hold a stale hand forever
  }

  private lowerHand(): void {
    if (this.handRaised) this.room?.cast({ k: "hand", raised: false, reason: "" });
    this.handReason = "";
    useStore.setState({ handRaised: false });
    if (!this.agentBusy) this.setStatus("listening");
  }

  private scheduleListenCheck(): void {
    clearTimeout(this.listenTimer);
    this.listenTimer = setTimeout(() => void this.listenCheck(), 2600);
  }

  private async listenCheck(): Promise<void> {
    if (this.agentBusy || this.handRaised || this.ttsSpeaking) return;
    const chars = this.buffer.reduce((n, l) => n + l.text.length, 0);
    if (chars < 60) return;
    if (Date.now() - this.lastListenAt < 20_000) { this.scheduleListenCheck(); return; }
    this.lastListenAt = Date.now();
    const batch = this.buffer.slice(-10);
    try {
      const res = await fetch(`${API}/api/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: batch }),
      });
      const out = (await res.json()) as { raise?: boolean; reason?: string };
      if (out.raise) this.raiseHand(out.reason ?? "");
    } catch { /* backend hiccup — stay quiet */ }
  }

  // ---------- the agent ----------
  private async runAgent({ question = "", invited = false, reason = "" }: { question?: string; invited?: boolean; reason?: string }): Promise<void> {
    if (this.agentBusy || this.remoteAgentActive) return;
    this.agentBusy = true;
    this.cancelled = false;
    this.lowerHand();
    this.room?.cast({ k: "agent-start" });
    this.setStatus("thinking…");
    useStore.setState({ thinking: true });
    this.agentAbort = new AbortController();

    let sawStep = false;
    try {
      const res = await fetch(`${API}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: this.agentAbort.signal,
        body: JSON.stringify({
          question,
          invited,
          reason,
          transcript: useStore.getState().transcript.slice(-14),
          board: this.wb ? this.wb.summary() : { title: null, nodes: [], arrows: [] },
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
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: StreamMsg;
          try { msg = JSON.parse(line) as StreamMsg; } catch { continue; }
          if (msg.type !== "step") continue;
          if (!sawStep) { sawStep = true; useStore.setState({ thinking: false }); }
          await this.playStep(msg, true);
          if (this.cancelled) { try { void reader.cancel(); } catch { /* noop */ } break outer; }
        }
      }
      if (!sawStep && !this.cancelled) {
        const line = "Hmm, I came up empty on that one — mind rephrasing?";
        this.caption("Forge", line, true);
        this.transcript("Forge", line);
        await this.speak(line);
      }
    } catch {
      if (!this.cancelled) {
        const line = "I can't reach my backend brain right now — is the server still running?";
        this.caption("Forge", line, true);
        this.transcript("Forge", line);
        await this.speak(line);
      }
    } finally {
      this.room?.cast({ k: "agent-end" });
      useStore.setState({ thinking: false });
      this.hideCaption();
      this.setStatus("listening");
      this.agentBusy = false;
      this.agentAbort = null;
      this.buffer = [];
    }
  }

  private async playStep(step: AgentStep, broadcast = false): Promise<void> {
    if (broadcast) this.room?.cast({ k: "step", say: step.say, ops: step.ops });
    if (step.ops?.length) {
      if (!useStore.getState().presenting) {
        this.enterPresenting();
        this.chime(1);
      }
      this.wb?.enqueue(step.ops);
    }
    this.caption("Forge", step.say, true);
    this.transcript("Forge", step.say);
    this.setStatus(step.ops?.length ? "presenting" : "speaking");
    await Promise.all([this.speak(step.say), this.waitBoardIdle()]);
    if (this.cancelled) { this.wb?.finishNow(); return; }
    await delay(320);
  }

  private waitBoardIdle(): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => {
        if (!this.wb?.busy || this.cancelled) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
  }

  cancelAgent(): void {
    this.room?.cast({ k: "cancel" });
    this.cancelled = true;
    this.agentAbort?.abort();
    this.cancelSpeech();
    this.wb?.finishNow();
    this.exitPresenting();
    this.setStatus("listening");
  }

  // ---------- utterance routing ----------
  handleUtterance(text: string, source: UtteranceSource): void {
    this.transcript(this.myName, text);
    this.room?.cast({ k: "utter", who: this.myName, text });

    if (STOP.test(text)) {
      this.cancelAgent();
      if (!this.agentBusy) { this.caption("Forge", "Sure — back to you."); void this.speak("Sure — back to you."); }
      return;
    }
    if (CLEAR.test(text)) {
      if (this.agentBusy) return;
      this.wb?.clear();
      this.room?.cast({ k: "board-clear" });
      this.caption("Forge", "Board's clean.");
      void this.speak("Board's clean.");
      return;
    }
    if (source === "typed" || WAKE.test(text)) {
      void this.runAgent({ question: text });
      return;
    }
    if (this.handRaised && INVITE.test(text)) {
      void this.runAgent({ invited: true, reason: this.handReason });
      return;
    }
    // Not addressed to Forge: listen passively, maybe raise hand.
    this.buffer.push({ who: this.myName, text });
    if (this.buffer.length > 14) this.buffer.shift();
    this.scheduleListenCheck();
  }

  // ---------- room sync (P2P call) ----------
  private onCast(ev: CastEvent): void {
    switch (ev.k) {
      case "utter":
        this.transcript(ev.who, ev.text);
        // Only the driver runs passive listen checks, so the hand raises once.
        if (this.room?.isDriver && !this.agentBusy && !this.remoteAgentActive) {
          this.buffer.push({ who: ev.who, text: ev.text });
          if (this.buffer.length > 14) this.buffer.shift();
          this.scheduleListenCheck();
        }
        break;
      case "agent-start":
        this.remoteAgentActive = true;
        this.cancelled = false;
        useStore.setState({ handRaised: false, thinking: true });
        this.setStatus("thinking…");
        break;
      case "step":
        useStore.setState({ thinking: false });
        this.remoteChain = this.remoteChain.then(() => this.playStep({ type: "step", say: ev.say, ops: ev.ops }));
        break;
      case "agent-end":
        this.remoteChain = this.remoteChain.then(() => {
          this.remoteAgentActive = false;
          this.hideCaption();
          this.setStatus("listening");
        });
        break;
      case "cancel":
        this.remoteAgentActive = false;
        this.cancelled = true;
        this.cancelSpeech();
        this.wb?.finishNow();
        this.exitPresenting();
        this.setStatus("listening");
        break;
      case "board-clear":
        this.wb?.clear();
        break;
      case "hand":
        this.handReason = ev.reason;
        useStore.setState({ handRaised: ev.raised });
        if (ev.raised) this.setStatus("✋ has a thought");
        else if (!this.agentBusy && !this.remoteAgentActive) this.setStatus("listening");
        break;
    }
  }

  // ---------- presenting / sounds ----------
  private enterPresenting(): void {
    useStore.setState({ presenting: true });
  }

  private exitPresenting(): void {
    useStore.setState({ presenting: false });
    if (!this.agentBusy) this.setStatus("listening");
  }

  private chime(gain = 1): void {
    const ac = this.audioCtx;
    if (!ac) return;
    const t0 = ac.currentTime;
    [523.25, 783.99].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.06 * gain, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.5);
      o.connect(g).connect(ac.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.55);
    });
  }

  // ---------- mic level → talking ring ----------
  private startMeter(): void {
    const stream = this.stream, ac = this.audioCtx;
    if (!stream || !ac) return;
    if (!stream.getAudioTracks().length) return;
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      requestAnimationFrame(loop);
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length) / 128;
      const micOn = stream.getAudioTracks()[0]?.enabled;
      const talking = !!micOn && rms > 0.045;
      if (useStore.getState().youTalking !== talking) useStore.setState({ youTalking: talking });
    };
    loop();
  }

  // ---------- boot ----------
  private placeholderStream(): MediaStream {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 360;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#171b22";
    ctx.fillRect(0, 0, 640, 360);
    return c.captureStream(2);
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      // No cam/mic: still let them join — typed questions keep working.
      this.stream = this.placeholderStream();
      useStore.setState({
        camOff: true,
        prejoinHint: `Camera/mic blocked (${(e as DOMException).name}) — joining without them; use the chat panel.`,
      });
    }
    useStore.setState({ streamReady: true });
  }

  private async fetchHealth(): Promise<void> {
    try {
      const res = await fetch(`${API}/api/health`);
      this.health = (await res.json()) as Health;
      useStore.setState({
        health: this.health,
        pill: {
          cls: "ok",
          title: `backend ok · brain: ${this.health.llm} · voice: ${this.health.tts ? "ElevenLabs" : "browser"} · repo: ${this.health.repo?.name}`,
        },
      });
    } catch {
      this.health = { ok: false, tts: false, llm: "?", repo: { name: "your repo" } };
      useStore.setState({
        health: this.health,
        pill: { cls: "err", title: "backend unreachable — start forge/backend (npm start)" },
      });
    }
  }

  async join(name?: string): Promise<void> {
    if (this.joined) return; // Join button is once-guarded
    this.joined = true;
    this.myName = (name || "").trim() || "You";
    useStore.setState({ phase: "room", myName: this.myName });

    this.audioCtx = new AudioContext();
    this.startMeter();

    this.recog = this.buildRecog();
    this.recogWanted = true;
    this.startRecog();
    if (!this.recog) this.caption("Forge", "Voice input needs Chrome — use the chat panel to ask me things.", true);

    await this.fetchHealth();
    this.room = new RoomLink({
      onCast: (ev) => this.onCast(ev),
      onPeerJoined: (peer) => { this.caption("Forge", `${peer} joined the call.`); this.chime(0.5); },
      onPeerLeft: (peer) => this.caption("Forge", `${peer} left the call.`),
    });
    this.room.connect(this.myName, this.stream);
    await delay(500);
    const repoName = this.health.repo?.name || "your repo";
    const greeting = this.health.ok
      ? `Hey, I'm Forge. I've read the ${repoName} codebase and I'm following along. Say my name to ask me anything, or just talk — I'll raise my hand when I can help.`
      : `Hey, I'm Forge. My backend isn't reachable, so start the server and reload — then I can really join in.`;
    this.caption("Forge", greeting, true);
    this.transcript("Forge", greeting);
    void this.speak(greeting);
  }

  // ---------- controls (invoked by components) ----------
  attachBoard(canvas: HTMLCanvasElement): Whiteboard {
    if (!this.wb || this.wb.canvas !== canvas) this.wb = new Whiteboard(canvas);
    return this.wb;
  }

  toggleMic(): void {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    useStore.setState({ micOn: track.enabled });
    this.recogWanted = track.enabled;
    if (track.enabled) this.startRecog();
    else this.stopRecog();
  }

  toggleCam(): void {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    useStore.setState({ camOn: track.enabled, camOff: !track.enabled });
  }

  toggleCC(): void {
    const ccOn = !useStore.getState().ccOn;
    useStore.setState({ ccOn });
    if (!ccOn) this.hideCaption();
  }

  togglePanel(): void {
    useStore.setState((s) => ({ panelOpen: !s.panelOpen }));
  }

  closePanel(): void {
    useStore.setState({ panelOpen: false });
  }

  handClick(): void {
    if (!this.agentBusy) void this.runAgent({ invited: true, reason: this.handReason });
  }

  ask(text: string): void {
    this.handleUtterance(text, "typed");
  }

  end(): void {
    this.room?.close();
    this.room = null;
    this.recogWanted = false;
    this.stopRecog();
    this.cancelSpeech();
    this.agentAbort?.abort();
    this.stream?.getTracks().forEach((t) => t.stop());
    useStore.setState({ phase: "ended" });
  }
}

export const session = new ForgeSession();
