// ForgeSession: all imperative call logic, framework-free. Owns the media
// stream, speech recognition, AudioContext (chime + mic meter), TTS playback
// (ElevenLabs streaming → MediaSource, browser speechSynthesis fallback), the
// /api/agent NDJSON reader loop with deferred step playback, and the passive
// listen buffer + raise-hand logic. UI state is pushed into the zustand store.

import { Whiteboard } from "./whiteboard";
import { RoomLink, type CastEvent } from "./rtc";
import { API, apiFetch } from "../config";
import { useStore } from "../state/store";
import type {
  AgentStep,
  Health,
  SpeechRecognitionLike,
  StreamMsg,
  TranscriptLine,
  WhiteboardOp,
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
const ISSUE_REQUEST_PHRASES = [
  "create a github issue",
  "create an github issue",
  "create new github issue",
  "create a new github issue",
  "open a github issue",
  "open an github issue",
  "open new github issue",
  "open a new github issue",
  "file a github issue",
  "file an github issue",
  "file new github issue",
  "file a new github issue",
] as const;

const isIssueRequest = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return ISSUE_REQUEST_PHRASES.some((phrase) => normalized.includes(phrase));
};

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

  // Board state is replayed to a participant who joins after Forge has drawn.
  private boardOps: WhiteboardOp[] = [];
  private boardMoves: Array<{ id: string; dx: number; dy: number }> = [];

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
          const res = await apiFetch(`${API}/api/tts/stream`, {
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

  // All speech goes through a chain so concurrent callers (ack line, agent
  // steps, peer-cast steps) never talk over each other.
  private speechChain: Promise<void> = Promise.resolve();

  private speak(text: string): Promise<void> {
    const run = this.speechChain.then(() => this.speakNow(text));
    this.speechChain = run.catch(() => {});
    return run;
  }

  private async speakNow(text: string): Promise<void> {
    if (this.cancelled && this.agentBusy) return; // skip queued lines after a barge-in
    this.ttsSpeaking = true;
    useStore.setState({ orbSpeaking: true, listeningActive: false });
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
    this.currentTtsAbort?.abort();
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
          // Keep recognition alive while Forge speaks so a participant can
          // barge in. During TTS, only explicit control phrases are accepted
          // to avoid treating Forge's own narration as meeting speech.
          if (text && (!this.ttsSpeaking || isAddressed(text) || STOP.test(text))) {
            this.handleUtterance(text, "voice");
          }
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
      const res = await apiFetch(`${API}/api/listen`, {
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

    try {
      // Fire-and-forget ack so the user knows we heard them, then think silently.
      const ackMsg = "Let me look into that.";
      this.caption("Forge", ackMsg, true);
      this.transcript("Forge", ackMsg);
      void this.speak(ackMsg);

      const res = await apiFetch(`${API}/api/agent`, {
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
            break outer;
          } else if (msg.type === "error") {
            // The backend follows an error event with a spoken fallback step.
            // Keep reading instead of discarding that useful recovery message.
            continue;
          }
          if (this.cancelled) { try { void reader.cancel(); } catch { /* noop */ } break outer; }
        }
      }

      // Play whatever arrived — even if the stream died before its "done"
      // marker, the steps we already parsed are still worth presenting.
      if (preparedSteps.length > 0) {
        useStore.setState({ thinking: false, thinkingTrace: [] });
        for (const step of preparedSteps) {
          if (this.cancelled) break;
          await this.playStep(step, true);
        }
      } else if (!this.cancelled) {
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
      useStore.setState({ thinking: false, thinkingTrace: [] });
      this.hideCaption();
      this.setListening();
      this.agentBusy = false;
      this.agentAbort = null;
      this.buffer = [];
      const next = this.pendingInterrupt;
      this.pendingInterrupt = null;
      if (next) setTimeout(() => void this.runAgent({ question: next, interrupted: true }), 250);
    }
  }

  private async playStep(step: AgentStep, broadcast = false): Promise<void> {
    if (broadcast) this.room?.cast({ k: "step", say: step.say, ops: step.ops });
    if (step.ops?.length) {
      this.boardOps.push(...step.ops);
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

  private async createGitHubIssue(command: string): Promise<void> {
    const context = useStore.getState().transcript
      .filter((line) => line.who !== "Forge" && line.text !== command)
      .slice(-12);
    try {
      const res = await apiFetch(`${API}/api/github/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, transcript: context }),
      });
      const out = (await res.json()) as { html_url?: string; number?: number; title?: string; error?: string };
      if (!res.ok || !out.html_url) throw new Error(out.error || "issue creation failed");
      await this.playStep({ type: "step", say: `Created GitHub issue number ${out.number}: ${out.title}.`, ops: [] }, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "issue creation failed";
      await this.playStep({ type: "step", say: `I couldn't create that GitHub issue: ${message}.`, ops: [] }, true);
    }
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
      this.boardOps = [];
      this.boardMoves = [];
      this.room?.cast({ k: "board-clear" });
      this.caption("Forge", "Board's clean.");
      void this.speak("Board's clean.");
      return;
    }
    if (isIssueRequest(text)) {
      void this.createGitHubIssue(text);
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
        // Skip queued steps if the run got cancelled while earlier ones played.
        this.remoteChain = this.remoteChain.then(() =>
          this.cancelled ? undefined : this.playStep({ type: "step", say: ev.say, ops: ev.ops })
        );
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
        this.boardOps = [];
        this.boardMoves = [];
        break;
      case "hand":
        this.handReason = ev.reason;
        useStore.setState({ handRaised: ev.raised });
        if (ev.raised) this.setStatus("\u270B has a thought");
        else if (!this.agentBusy && !this.remoteAgentActive) this.setListening();
        break;
      case "board-edit":
        this.cancelForBoardEdit();
        break;
      case "board-move":
        this.wb?.moveItem(ev.id, ev.dx, ev.dy);
        this.boardMoves.push({ id: ev.id, dx: ev.dx, dy: ev.dy });
        break;
      case "board-sync":
        this.wb?.clear();
        this.boardOps = [...ev.ops];
        this.boardMoves = [...ev.moves];
        this.wb?.enqueue(ev.ops);
        this.wb?.finishNow();
        for (const move of ev.moves) this.wb?.moveItem(move.id, move.dx, move.dy);
        break;
      case "focus":
        useStore.setState({ codePanelHighlight: { start: ev.startLine, end: ev.endLine } });
        break;
      case "code-panel-open":
        void this.loadCodePanel(ev.file, ev.startLine, ev.endLine, ev.githubUrl);
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
      const res = await apiFetch(`${API}/api/health`);
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
      onPeerJoined: (peer) => {
        this.caption("Forge", `${peer} joined the call.`);
        this.chime(0.5);
        this.syncBoardToPeer();
      },
      onPeerLeft: (peer) => this.caption("Forge", `${peer} left the call.`),
    });
    this.room.connect(this.myName, this.stream);
    useStore.setState({ listeningActive: true });
  }

  // ---------- controls (invoked by components) ----------
  private syncBoardToPeer(): void {
    if (!this.boardOps.length) return;
    this.room?.cast({ k: "board-sync", ops: this.boardOps, moves: this.boardMoves });
  }

  attachBoard(canvas: HTMLCanvasElement): Whiteboard {
    if (!this.wb || this.wb.canvas !== canvas) {
      this.wb = new Whiteboard(canvas);
      // A peer can finish its room sync before React mounts this canvas.
      // Replaying the saved state makes that timing harmless.
      if (this.boardOps.length) {
        this.wb.enqueue(this.boardOps);
        this.wb.finishNow();
        for (const move of this.boardMoves) this.wb.moveItem(move.id, move.dx, move.dy);
      }
    }
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
    this.boardMoves.push({ id, dx, dy });
    this.room?.cast({ k: "board-move", id, dx, dy });
  }

  openCodePanel(attr: { file: string; startLine?: number; endLine?: number }, nodeLabel = "this component"): void {
    const params = new URLSearchParams({ path: attr.file });
    if (attr.startLine != null) params.set("start", String(attr.startLine));
    if (attr.endLine != null) params.set("end", String(attr.endLine));
    apiFetch(`${API}/api/repo/file?${params}`)
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
        this.room?.cast({
          k: "code-panel-open",
          file: data.path,
          startLine: data.startLine,
          endLine: attr.endLine,
          githubUrl: data.githubUrl,
        });
        // kick off the live walkthrough now that the panel is open
        void this.runWalkthrough(nodeLabel, attr);
      })
      .catch(() => { /* silently ignore missing file endpoint */ });
  }

  private async loadCodePanel(file: string, startLine?: number, endLine?: number, githubUrl?: string): Promise<void> {
    const params = new URLSearchParams({ path: file });
    if (startLine != null) params.set("start", String(startLine));
    if (endLine != null) params.set("end", String(endLine));
    try {
      const res = await apiFetch(`${API}/api/repo/file?${params}`);
      if (!res.ok) return;
      const data = (await res.json()) as { path: string; startLine: number; lines: string[]; githubUrl?: string };
      useStore.setState({
        codePanelOpen: true,
        codePanelFile: data.path,
        codePanelLines: data.lines,
        codePanelStartLine: data.startLine,
        codePanelGithubUrl: data.githubUrl ?? githubUrl ?? null,
        codePanelHighlight: startLine != null ? { start: startLine, end: endLine ?? startLine } : null,
      });
    } catch { /* remote code view is best-effort */ }
  }

  async runWalkthrough(nodeLabel: string, attr: { file: string; startLine?: number; endLine?: number }): Promise<void> {
    const board = this.wb ? this.wb.summary() : { title: null, nodes: [], arrows: [] };
    try {
      const res = await apiFetch(`${API}/api/agent/walkthrough`, {
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
