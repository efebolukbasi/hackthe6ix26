// ForgeSession: all imperative call logic, framework-free. Owns the media
// stream, speech recognition, AudioContext (chime + mic meter), TTS playback
// (ElevenLabs streaming → MediaSource, browser speechSynthesis fallback), the
// /api/agent NDJSON reader loop with deferred step playback, and the passive
// listen buffer + raise-hand logic. UI state is pushed into the zustand store.

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

// Direct-address detection: Forge speaks only when spoken TO — its name at
// the start of the utterance (optionally after a lead-in like "hey"), or as a
// vocative tag at the end ("what do you think, Forge?"). Casual mid-sentence
// mentions ("the forge repo is big") must NOT trigger it.
const LEAD_IN = "(?:hey|hi|ok|okay|so|well|listen)";
const NAME = "(?:forge|archie)";
const ADDRESS_START = new RegExp(`^\\s*(?:${LEAD_IN}[\\s,]+)?${NAME}\\b[\\s,]*`, "i");
const ADDRESS_END = new RegExp(`(?:,\\s*(?:right\\s*)?|\\bright\\s*,?\\s*)${NAME}[\\s?!.,]*$`, "i");

const isAddressed = (text: string): boolean => ADDRESS_START.test(text) || ADDRESS_END.test(text);

// Remove the address prefix / vocative tag so Claude gets the clean question.
function stripAddress(text: string): string {
  return text.replace(ADDRESS_START, "").replace(ADDRESS_END, "").trim();
}

const INVITE = /\b(go ahead|go for it|take it away|what do you think|your thoughts|tell us|share it|yes forge|sure forge|floor is yours|let's hear it)\b/i;
const STOP = /\b(stop presenting|back to (the )?grid|that'?s enough|stop talking|be quiet|thanks,? forge|thank you,? forge)\b/i;
const CLEAR = /\b((clear|wipe) the board|start over|clean slate)\b/i;
const CODE_COMMAND = /\b(improve|fix|refactor|add|build|create|update|delete|remove|implement|write|generate)\b.*\b(the\s+)?(frontend|backend|component|function|test|api|code|feature|endpoint|hook|class|style|css|route)/i;

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
  private currentTtsAbort: AbortController | null = null;
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
  private pendingInterrupt: string | null = null;
  private remoteAgentActive = false;
  private remoteChain: Promise<void> = Promise.resolve();
  private myName = "You";

  // Speaker-role: the peer with the lower room id plays TTS audio. Others
  // only update captions and board state. Defaults to true (alone in room).
  private isSpeaker = true;

  // Deferred answer flow: steps are collected silently, then presented when invited.
  private pendingSteps: AgentStep[] = [];

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

  /** Transition Forge to the "listening" state and play a soft listening chime. */
  private setListening(): void {
    this.setStatus("listening");
    const wasActive = useStore.getState().listeningActive;
    useStore.setState({ listeningActive: true });
    if (!wasActive) this.listeningChime();
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
    if (!("MediaSource" in window)) { return this.browserSpeak(text); }
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const a = new Audio(url);
    this.currentAudio = a;
    const abortCtrl = new AbortController();
    this.currentTtsAbort = abortCtrl;
    return new Promise<void>((resolve, reject) => {
      ms.addEventListener("sourceopen", async () => {
        let sb: SourceBuffer;
        try { sb = ms.addSourceBuffer("audio/mpeg"); } catch { resolve(); return; }
        const queue: ArrayBuffer[] = [];
        let appending = false;
        const drain = () => {
          if (appending || !queue.length) return;
          if (sb.updating) { sb.addEventListener("updateend", drain, { once: true }); return; }
          appending = true;
          sb.appendBuffer(queue.shift()!);
        };
        sb.addEventListener("updateend", () => { appending = false; drain(); });
        try {
          const res = await fetch(`${API}/api/tts/stream`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }), signal: abortCtrl.signal,
          });
          if (!res.ok) throw new Error(`tts/stream ${res.status}`);
          const reader = res.body!.getReader();
          a.play().catch(() => {});
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            queue.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
            drain();
          }
          // Wait for buffer to drain then end stream
          await new Promise<void>(r => {
            const check = () => { if (!sb.updating && !queue.length) r(); else setTimeout(check, 50); };
            check();
          });
          if (ms.readyState === "open") ms.endOfStream();
        } catch (err) {
          if (!abortCtrl.signal.aborted) reject(err);
          else resolve();
          return;
        }
        a.addEventListener("ended", () => resolve(), { once: true });
        a.addEventListener("error", () => resolve(), { once: true });
      });
      a.addEventListener("error", () => resolve(), { once: true });
    }).finally(() => {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
      this.currentTtsAbort = null;
    });
  }

  private async speak(text: string): Promise<void> {
    this.ttsSpeaking = true;
    this.stopRecog(); // don't transcribe our own voice
    useStore.setState({ orbSpeaking: true, listeningActive: false });
    if (this.isSpeaker) {
      try {
        if (!this.health.tts || this.cancelled) throw new Error("tts off");
        await this.elevenSpeak(text);
      } catch {
        if (!this.cancelled) await this.browserSpeak(text);
      }
    }
    this.ttsSpeaking = false;
    useStore.setState({ orbSpeaking: false });
    setTimeout(() => this.startRecog(), 300);
  }

  private cancelSpeech(): void {
    speechSynthesis.cancel();
    this.currentTtsAbort?.abort();
    if (this.currentAudio) { try { this.currentAudio.pause(); } catch { /* noop */ } this.currentAudio = null; }
  }

  setIsSpeaker(val: boolean): void {
    this.isSpeaker = val;
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
    if (!this.agentBusy) this.setListening();
  }

  private scheduleListenCheck(): void {
    clearTimeout(this.listenTimer);
    this.listenTimer = setTimeout(() => void this.listenCheck(), 2600);
  }

  private async listenCheck(): Promise<void> {
    if (this.agentBusy || this.handRaised || this.ttsSpeaking) return;
    const chars = this.buffer.reduce((n, l) => n + l.text.length, 0);
    if (chars < 80) return;
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
  private async runAgent({ question = "", invited = false, reason = "", interrupted = false }: { question?: string; invited?: boolean; reason?: string; interrupted?: boolean }): Promise<void> {
    if (this.agentBusy || this.remoteAgentActive) return;
    this.agentBusy = true;
    this.cancelled = false;
    this.lowerHand();
    this.room?.cast({ k: "agent-start" });
    this.setStatus("thinking…");
    useStore.setState({ thinking: true, listeningActive: false });
    this.agentAbort = new AbortController();

    let handedOff = false;
    try {
      // If invited and we have prepared steps, play them without fetching again.
      if (invited && this.pendingSteps.length > 0) {
        const steps = this.pendingSteps;
        this.pendingSteps = [];
        useStore.setState({ thinking: false, thinkingTrace: [] });
        for (const step of steps) {
          if (this.cancelled) break;
          await this.playStep(step, true);
        }
        return;
      }

      // Fire-and-forget ack so the user knows we heard them, then think silently.
      const ackMsg = "Let me look into that — I'll raise my hand when I have something.";
      this.caption("Forge", ackMsg, true);
      this.transcript("Forge", ackMsg);
      void this.speak(ackMsg);

      const res = await fetch(`${API}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: this.agentAbort.signal,
        body: JSON.stringify({
          question,
          invited,
          reason,
          interrupted,
          transcript: useStore.getState().transcript.slice(-14),
          board: this.wb ? this.wb.summary() : { title: null, nodes: [], arrows: [] },
        }),
      });
      if (!res.ok || !res.body) throw new Error(`agent ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const preparedSteps: AgentStep[] = [];
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
          if (msg.type === "tool") {
            const t = msg as { type: "tool"; name: string; input: string };
            useStore.setState((s) => ({ thinkingTrace: [...s.thinkingTrace, `\uD83D\uDD0D ${t.name}: ${t.input.slice(0, 60)}`] }));
          } else if (msg.type === "step") {
            useStore.setState({ thinking: false });
            preparedSteps.push(msg);
          } else if (msg.type === "done") {
            if (preparedSteps.length > 0) {
              // Defer presentation: store steps and raise hand for invite.
              handedOff = true;
              this.pendingSteps = preparedSteps;
              this.room?.cast({ k: "agent-end" });
              useStore.setState({ thinking: false, thinkingTrace: [] });
              this.agentBusy = false;
              this.raiseHand("ready-to-present");
              return;
            }
            break outer;
          } else if (msg.type === "error") {
            throw new Error((msg as { type: "error"; message: string }).message);
          }
          if (this.cancelled) { try { void reader.cancel(); } catch { /* noop */ } break outer; }
        }
      }

      if (preparedSteps.length === 0 && !this.cancelled) {
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
      if (!handedOff) {
        this.room?.cast({ k: "agent-end" });
        useStore.setState({ thinking: false, thinkingTrace: [] });
        this.hideCaption();
        this.setListening();
        this.agentBusy = false;
        this.agentAbort = null;
        this.buffer = [];
        const next = this.pendingInterrupt;
        this.pendingInterrupt = null;
        if (next) setTimeout(() => void this.runAgent({ question: next, interrupted: true }), 250);
      } else {
        // Already cleaned up in the try block before returning.
        this.agentAbort = null;
        this.buffer = [];
      }
    }
  }

  async runCodeAgent(task: string): Promise<void> {
    if (this.agentBusy) return;
    this.agentBusy = true;
    this.cancelled = false;
    this.lowerHand();
    this.room?.cast({ k: "agent-start" });
    this.setStatus("coding\u2026");
    useStore.setState({ thinking: true, thinkingTrace: [], listeningActive: false });
    const ack = "On it \u2014 I'll make those changes and report back.";
    this.caption("Forge", ack, true); this.transcript("Forge", ack);
    void this.speak(ack); // fire-and-forget
    try {
      const res = await fetch(`${API}/api/agent/code`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const reader = res.body!.getReader(); const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { type: string; name?: string; input?: string; text?: string; summary?: string; message?: string };
            if (msg.type === "tool") useStore.setState((s) => ({ thinkingTrace: [...s.thinkingTrace, `\uD83D\uDD27 ${msg.name ?? ""}: ${String(msg.input ?? "").slice(0, 60)}`] }));
            if (msg.type === "progress") useStore.setState((s) => ({ thinkingTrace: [...s.thinkingTrace, String(msg.text ?? "").slice(0, 80)] }));
            if (msg.type === "done") {
              const summary = msg.summary || "Done.";
              this.caption("Forge", summary, true); this.transcript("Forge", summary);
              this.room?.cast({ k: "step", say: summary, ops: [] });
              await this.speak(summary);
            }
            if (msg.type === "error") throw new Error(msg.message);
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      if (!this.cancelled) {
        const line = err instanceof Error && err.message.includes("claude")
          ? "I need Claude Code CLI installed and no API key to use coding mode."
          : "Something went wrong with that coding task.";
        this.caption("Forge", line, true); this.transcript("Forge", line); await this.speak(line);
      }
    } finally {
      this.room?.cast({ k: "agent-end" });
      useStore.setState({ thinking: false, thinkingTrace: [] });
      this.hideCaption(); this.setListening();
      this.agentBusy = false;
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

  // Barge-in: halt the current explanation, then re-run with the new request.
  // The board stays as-is so the follow-up can build on it.
  private interrupt(text: string): void {
    this.pendingInterrupt = text;
    this.cancelled = true;
    this.agentAbort?.abort();
    this.cancelSpeech();
    this.wb?.finishNow();
  }

  cancelAgent(): void {
    this.room?.cast({ k: "cancel" });
    this.cancelled = true;
    this.agentAbort?.abort();
    this.cancelSpeech();
    this.wb?.finishNow();
    this.exitPresenting();
    this.setListening();
    useStore.setState({ thinkingTrace: [] });
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

    // Check INVITE *before* direct address — "Forge, go ahead" invites rather than re-asks.
    if (this.handRaised && INVITE.test(text)) {
      void this.runAgent({ invited: true, reason: this.handReason });
      return;
    }

    if (source === "typed" || isAddressed(text)) {
      const question = source === "typed" ? text : stripAddress(text) || text;
      if (this.agentBusy) { this.interrupt(question); return; }
      if (this.remoteAgentActive) {
        // 1f: Stop mirrored run immediately and take over with the new ask.
        this.room?.cast({ k: "cancel" });
        this.remoteAgentActive = false;
        this.cancelled = true;
        this.cancelSpeech();
        this.wb?.finishNow();
        this.exitPresenting();
        this.setListening();
        void this.runAgent({ question, interrupted: true });
        return;
      }
      // Check for imperative coding command (Phase 5).
      if (CODE_COMMAND.test(question)) {
        void this.runCodeAgent(question);
        return;
      }
      void this.runAgent({ question });
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
        useStore.setState({ handRaised: false, thinking: true, listeningActive: false });
        this.setStatus("thinking\u2026");
        break;
      case "step":
        useStore.setState({ thinking: false });
        this.remoteChain = this.remoteChain.then(() => this.playStep({ type: "step", say: ev.say, ops: ev.ops }));
        break;
      case "agent-end":
        this.remoteChain = this.remoteChain.then(() => {
          this.remoteAgentActive = false;
          this.hideCaption();
          this.setListening();
        });
        break;
      case "cancel":
        this.remoteAgentActive = false;
        this.cancelled = true;
        if (this.agentBusy) this.agentAbort?.abort(); // peer cancelled OUR run
        this.cancelSpeech();
        this.wb?.finishNow();
        this.exitPresenting();
        this.setListening();
        useStore.setState({ thinkingTrace: [] });
        break;
      case "board-clear":
        this.wb?.clear();
        break;
      case "hand":
        this.handReason = ev.reason;
        useStore.setState({ handRaised: ev.raised });
        if (ev.raised) this.setStatus("\u270B has a thought");
        else if (!this.agentBusy && !this.remoteAgentActive) this.setListening();
        break;
      case "speaker-role":
        // Remote says whether THEY are speaker; we are speaker if they are not.
        this.isSpeaker = !ev.isSpeaker;
        break;
      case "board-edit":
        this.cancelForBoardEdit();
        break;
      case "board-move":
        this.wb?.moveItem(ev.id, ev.dx, ev.dy);
        break;
      case "focus":
        useStore.setState({ codePanelHighlight: { start: ev.startLine, end: ev.endLine } });
        break;
      case "code-panel-open":
        useStore.setState({ codePanelOpen: true, codePanelFile: ev.file, codePanelGithubUrl: ev.githubUrl ?? null });
        break;
    }
  }

  // ---------- presenting / sounds ----------
  private enterPresenting(): void {
    useStore.setState({ presenting: true });
  }

  private exitPresenting(): void {
    useStore.setState({ presenting: false });
    if (!this.agentBusy) this.setListening();
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

  /** Soft single-note ping when Forge becomes ready to listen again. */
  private listeningChime(): void {
    const ac = this.audioCtx;
    if (!ac) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.04, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + 0.2);
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
    useStore.setState({ listeningActive: true });
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

  // ---------- board edit + code panel (Phase 6c) ----------
  private cancelForBoardEdit(): void {
    this.cancelled = true;
    this.agentAbort?.abort();
    this.cancelSpeech();
    this.wb?.finishNow();
    this.setListening();
    useStore.setState({ thinkingTrace: [] });
  }

  onBoardEdit(): void {
    this.cancelForBoardEdit();
    this.room?.cast({ k: "board-edit" });
  }

  moveBoardItem(id: string, dx: number, dy: number): void {
    this.wb?.moveItem(id, dx, dy);
    this.room?.cast({ k: "board-move", id, dx, dy });
  }

  openCodePanel(attr: { file: string; startLine?: number; endLine?: number }, nodeLabel = "this component"): void {
    const params = new URLSearchParams({ path: attr.file });
    if (attr.startLine != null) params.set("start", String(attr.startLine));
    if (attr.endLine != null) params.set("end", String(attr.endLine));
    fetch(`${API}/api/repo/file?${params}`)
      .then((r) => r.json())
      .then((data: { path: string; startLine: number; lines: string[]; githubUrl?: string }) => {
        useStore.setState({
          codePanelOpen: true,
          codePanelFile: data.path,
          codePanelLines: data.lines,
          codePanelStartLine: data.startLine,
          codePanelGithubUrl: data.githubUrl ?? null,
          codePanelHighlight: attr.startLine != null
            ? { start: attr.startLine, end: attr.endLine ?? attr.startLine }
            : null,
        });
        this.room?.cast({ k: "code-panel-open", file: data.path, githubUrl: data.githubUrl });
        // kick off the live walkthrough now that the panel is open
        void this.runWalkthrough(nodeLabel, attr);
      })
      .catch(() => { /* silently ignore missing file endpoint */ });
  }

  async runWalkthrough(nodeLabel: string, attr: { file: string; startLine?: number; endLine?: number }): Promise<void> {
    const board = this.wb ? this.wb.summary() : { title: null, nodes: [], arrows: [] };
    try {
      const res = await fetch(`${API}/api/agent/walkthrough`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: nodeLabel,
          nodeLabel,
          attr,
          transcript: useStore.getState().transcript.slice(-8),
          board,
        }),
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { type: string; say?: string; ops?: AgentStep["ops"]; file?: string; startLine?: number; endLine?: number };
            if (msg.type === "step") {
              await this.playStep({ type: "step", say: msg.say ?? "", ops: msg.ops }, true);
            } else if (msg.type === "focus") {
              const hl = { start: msg.startLine ?? 1, end: msg.endLine ?? 1 };
              useStore.setState({ codePanelHighlight: hl });
              this.room?.cast({ k: "focus", file: msg.file ?? "", startLine: hl.start, endLine: hl.end });
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch { /* silently fail — walkthrough is best-effort */ }
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
