// ForgeSession: all imperative call logic, framework-free. Owns the media
// stream, speech recognition, AudioContext (chime + mic meter), TTS playback
// (ElevenLabs streaming → MediaSource, browser speechSynthesis fallback), the
// /api/agent NDJSON reader loop with deferred step playback, and the passive
// listen buffer + raise-hand logic. UI state is pushed into the zustand store.

import { Whiteboard } from "./whiteboard";
import { layoutSteps } from "./layout";
import { RoomLink, type CastEvent, type StageSync } from "./rtc";
import { API, apiFetch } from "../config";
import { useStore, type ForgeStage } from "../state/store";
import type {
  AgentStep,
  ForgeTask,
  ForgeTaskKind,
  ForgeTaskStatus,
  Health,
  SpeechRecognitionLike,
  StreamMsg,
  TranscriptLine,
  WhiteboardOp,
} from "../types";

const TERMINAL_TASK = new Set<ForgeTaskStatus>(["done", "cancelled", "error"]);
const TASK_PRUNE_MS = 6_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const normalizeSpeech = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

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
// Explicit stop phrases work anywhere in an utterance, any time.
const STOP = /\b(stop presenting|back to (the )?grid|that'?s enough|stop talking|be quiet|thanks,? forge|thank you,? forge)\b/i;
// Bare barge-in words ("stop", "wait", "hold on") count only as a WHOLE
// utterance — "we should stop using X" must never cut Forge off — and only
// while Forge is actually talking or working (see isStopCommand callers).
const BARE_STOP = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(?:forge[\s,]+)?(?:stop|wait|hold on|hang on|pause|quiet|shut up|enough)[\s!.,]*$/i;
const CLEAR = /\b((clear|wipe) the board|start over|clean slate)\b/i;
/** "cancel everything" also flushes the queued asks, not just the live run. */
const CANCEL_ALL = /\b(cancel everything|stop everything|never ?mind|forget it|drop (it|everything))\b/i;

// "create/open/file/make/raise/add/log … (github) issue" — imperative verb
// required so questions about issues ("why did the issue get created twice?")
// never trigger a new one.
const ISSUE_CREATE = /\b(?:create|open|file|make|raise|add|log)\b[\s\w']{0,40}?\b(?:github\s+)?issue\b/i;
const isIssueRequest = (text: string): boolean =>
  ISSUE_CREATE.test(text) && !/^\s*(?:who|what|why|when|where|how|did|is|was|were|should|could|can|do|does)\b/i.test(text);

// "work on / implement / fix / pick up … issue (number) 3" — plus "that
// issue" / "the issue you just created" resolving to the most recent one.
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const IMPLEMENT_VERB = /\b(?:work on|implement|fix|take on|tackle|pick up|handle|resolve|address|start on|build|do)\b/i;
const IMPLEMENT_PR = /\b(?:open|make|create|raise)\b[\s\w']{0,24}?\b(?:pull request|pr)\b[\s\w']{0,24}?\bissue\b/i;
const ISSUE_NUMBER = /\bissue\s+(?:number\s+)?(?:#\s*)?(\d{1,5}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const ISSUE_LAST = /\b(?:that|this|the last|the latest|the new)\s+issue\b|\bissue\s+(?:you|we)\s+just\b/i;

/** Extract the implement-issue intent, if this utterance is one. */
function parseImplementRequest(text: string, lastIssueNumber: number | null): number | null {
  if (!(IMPLEMENT_VERB.test(text) || IMPLEMENT_PR.test(text))) return null;
  if (!/\bissue\b/i.test(text)) return null;
  if (/^\s*(?:who|what|why|when|where|how|did|is|was|were|should|could|can)\b/i.test(text)) return null;
  const m = ISSUE_NUMBER.exec(text);
  if (m) {
    const raw = m[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
    if (Number.isInteger(n) && n >= 1) return n;
  }
  if (ISSUE_LAST.test(text) && lastIssueNumber) return lastIssueNumber;
  return null;
}

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
  /** Settles the in-flight ElevenLabs playback promise on barge-in — a paused
   * audio element never fires "ended", which would leave the speech chain
   * (and the whole run's cleanup) hanging until the watchdog. */
  private currentTtsFinish: (() => void) | null = null;
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
  /** FIFO of asks made while Forge was busy — they run in order afterwards. */
  private askQueue: Array<{ text: string; taskId: string }> = [];
  private remoteAgentActive = false;
  private remoteChain: Promise<void> = Promise.resolve();
  private myName = "You";

  // Task registry: ids are namespaced by a per-session uid so ownership
  // survives name collisions across the two clients.
  private sid = Math.random().toString(36).slice(2, 8);
  private taskSeq = 0;
  private activeTaskId: string | null = null;
  private walkthroughAbort: AbortController | null = null;
  /** Abort controllers for background flows (issue / PR), keyed by task id. */
  private flowAborts = new Map<string, AbortController>();
  /** Serialize background GitHub flows so they never race each other. */
  private flowChain: Promise<void> = Promise.resolve();
  /** Recently started issue commands (normalized) — drops rapid duplicates. */
  private recentIssueCommands: Array<{ norm: string; at: number }> = [];
  private lastIssueNumber: number | null = null;
  /** Last final voice transcript — Chrome re-fires finals across restarts. */
  private lastVoiceFinal: { norm: string; at: number } | null = null;
  private taskPruneTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Board state is replayed to a participant who joins after Forge has drawn.
  private boardOps: WhiteboardOp[] = [];
  private boardMoves: Array<{ id: string; dx: number; dy: number }> = [];

  // Shared repo stage: the file location currently on stage (null when the
  // panel is closed).
  private stage: { file: string; startLine?: number; endLine?: number } | null = null;

  // Self-echo filter state: what Forge itself said recently, plus a short
  // window after TTS ends during which Chrome is still finalizing audio it
  // heard while Forge was talking.
  private recentForgeLines: Array<{ text: string; expires: number }> = [];
  private ttsTailUntil = 0;

  // Resolves the "ready" pause early when someone invites Forge to speak.
  private readyRelease: (() => void) | null = null;

  constructor() {
    // Demo/debug hooks: feed an utterance as if it were heard through the mic
    // (handy in loud demo halls: window.forge.hear("we should use redis for
    // this")), and draw a sample board with no backend (window.forge.demo()).
    window.forge = {
      hear: (text: string) => this.handleUtterance(text, "voice"),
      interim: (text: string) => this.showInterim(text),
      demo: () => this.demoBoard(),
      board: () => this.wb,
    };
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

  /** Single place every stage transition goes through, so the visible status
   * can never disagree with what Forge is actually doing. */
  private setStage(stage: ForgeStage, detail = ""): void {
    const labels: Record<ForgeStage, string> = {
      listening: "listening",
      working: "working on it…",
      ready: "✋ ready to answer",
      presenting: "presenting",
      speaking: "speaking",
      hand: "✋ has a thought",
    };
    useStore.setState({ stage, agentStatus: detail || labels[stage] });
  }

  /** Transition Forge to the "listening" state and play a soft listening chime. */
  private setListening(): void {
    this.setStage("listening");
    const wasActive = useStore.getState().listeningActive;
    useStore.setState({ listeningActive: true });
    if (!wasActive) this.listeningChime();
  }

  /** Record a tool/progress line on the owning task and mirror it to the
   * peer. The task registry is the single visible surface for this detail. */
  private traceLine(line: string, taskId: string | null = this.activeTaskId, cast = true): void {
    useStore.setState((s) => ({ thinkingTrace: [...s.thinkingTrace.slice(-11), line] }));
    this.taskTrace(taskId, line);
    if (cast) this.room?.cast({ k: "trace", line });
  }

  // ---------- task registry ----------
  // Every autonomous unit of Forge work (answer or issue) is a task both
  // participants can see and cancel. Owners drive their tasks and cast
  // upserts; a peer cancels someone else's task by asking the owner.

  private upsertTask(task: ForgeTask, cast = true): void {
    useStore.setState((s) => {
      const i = s.tasks.findIndex((t) => t.id === task.id);
      return { tasks: i >= 0 ? s.tasks.map((t, j) => (j === i ? task : t)) : [...s.tasks, task] };
    });
    if (cast && task.mine) {
      const { mine: _mine, ...wire } = task;
      this.room?.cast({ k: "task", task: wire });
    }
    if (TERMINAL_TASK.has(task.status)) this.scheduleTaskPrune(task.id);
  }

  private scheduleTaskPrune(id: string): void {
    clearTimeout(this.taskPruneTimers.get(id));
    this.taskPruneTimers.set(id, setTimeout(() => {
      this.taskPruneTimers.delete(id);
      useStore.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    }, TASK_PRUNE_MS));
  }

  private newTask(kind: ForgeTaskKind, label: string, status: ForgeTaskStatus = "queued"): ForgeTask {
    const task: ForgeTask = {
      id: `${this.sid}-${++this.taskSeq}`,
      kind,
      label: label.trim().slice(0, 90) || "Forge task",
      status,
      trace: [],
      mine: true,
    };
    this.upsertTask(task);
    return task;
  }

  /** Update a live task; finished tasks stay finished (a late "done" must
   * never resurrect a task someone cancelled). */
  private setTask(id: string | null, patch: Partial<Pick<ForgeTask, "status" | "label">>): void {
    if (!id) return;
    const cur = useStore.getState().tasks.find((t) => t.id === id);
    if (!cur || TERMINAL_TASK.has(cur.status)) return;
    this.upsertTask({ ...cur, ...patch });
  }

  private taskTrace(id: string | null, line: string): void {
    if (!id) return;
    const cur = useStore.getState().tasks.find((t) => t.id === id);
    if (!cur || TERMINAL_TASK.has(cur.status)) return;
    this.upsertTask({ ...cur, trace: [...cur.trace.slice(-9), line] });
  }

  /** Cancel a task from the registry UI. Peer-owned tasks are cancelled by
   * asking their owner; local ones stop the matching work directly. */
  cancelTask(id: string): void {
    const task = useStore.getState().tasks.find((t) => t.id === id);
    if (!task || TERMINAL_TASK.has(task.status)) return;
    if (!task.mine) {
      this.room?.cast({ k: "task-cancel", id });
      return;
    }
    const queued = this.askQueue.findIndex((q) => q.taskId === id);
    if (queued >= 0) {
      this.askQueue.splice(queued, 1);
      this.setTask(id, { status: "cancelled" });
      return;
    }
    if (this.activeTaskId === id) {
      this.cancelAgent();
      return;
    }
    const flow = this.flowAborts.get(id);
    if (flow) flow.abort();
    this.setTask(id, { status: "cancelled" });
  }

  // ---------- self-echo filter ----------
  // Speech recognition stays on while Forge talks (for barge-in), and Chrome
  // often finalizes the tail of Forge's own TTS seconds AFTER playback ends.
  // Without this filter that tail gets logged as if a human in the call said it.

  private noteForgeLine(text: string): void {
    const now = Date.now();
    this.recentForgeLines = this.recentForgeLines.filter((l) => l.expires > now);
    const norm = normalizeSpeech(text);
    if (norm) this.recentForgeLines.push({ text: norm, expires: now + 30_000 });
  }

  private inTtsTail(): boolean {
    return this.ttsSpeaking || Date.now() < this.ttsTailUntil;
  }

  private isSelfEcho(raw: string): boolean {
    const heard = normalizeSpeech(raw);
    if (!heard) return false;
    const tokens = heard.split(" ");
    const now = Date.now();
    for (const line of this.recentForgeLines) {
      if (line.expires <= now) continue;
      // Verbatim fragment of something Forge just said.
      if ((tokens.length >= 3 || this.inTtsTail()) && line.text.includes(heard)) return true;
      // Fuzzy: most of the heard words came out of Forge's own mouth.
      if (tokens.length >= 4) {
        const lineTokens = new Set(line.text.split(" "));
        let overlap = 0;
        for (const t of tokens) if (lineTokens.has(t)) overlap++;
        if (overlap / tokens.length >= 0.7) return true;
      }
    }
    return false;
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
      u.volume = useStore.getState().forgeVolume;
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
    a.volume = useStore.getState().forgeVolume;
    this.currentAudio = a;
    const abortCtrl = new AbortController();
    this.currentTtsAbort = abortCtrl;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve();
      };
      this.currentTtsFinish = finish;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (abortCtrl.signal.aborted) resolve();
        else reject(err instanceof Error ? err : new Error(String(err)));
      };
      // Every Forge line on every client sits behind the speech chain — if this
      // promise never settles (blocked autoplay, stalled stream), that client
      // goes permanently silent while the other participant keeps hearing
      // Forge fine. The watchdog guarantees the chain always moves on.
      const watchdog = setTimeout(finish, Math.max(15_000, text.split(/\s+/).length * 700 + 8_000));
      ms.addEventListener("sourceopen", async () => {
        let sb: SourceBuffer;
        try { sb = ms.addSourceBuffer("audio/mpeg"); } catch { finish(); return; }
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
          // A blocked play() means nobody would ever hear this line — fail
          // fast so the caller falls back to browser TTS instead of silence.
          a.play().catch((err) => fail(err));
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            queue.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
            drain();
          }
          // Wait for buffer to drain then end stream
          await new Promise<void>(r => {
            const check = () => { if (settled || (!sb.updating && !queue.length)) r(); else setTimeout(check, 50); };
            check();
          });
          if (!settled && ms.readyState === "open") ms.endOfStream();
        } catch (err) {
          fail(err);
          return;
        }
        a.addEventListener("ended", finish, { once: true });
        a.addEventListener("error", finish, { once: true });
      });
      a.addEventListener("error", finish, { once: true });
    }).finally(() => {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
      this.currentTtsAbort = null;
      this.currentTtsFinish = null;
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

  /** Pronunciation + cleanup applied ONLY to the audio path — captions and
   * the transcript keep the real spelling. */
  private ttsText(text: string): string {
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

  private async speakNow(text: string): Promise<void> {
    if (this.cancelled && this.agentBusy) return; // skip queued lines after a barge-in
    const spoken = this.ttsText(text);
    this.noteForgeLine(text); // remember it BEFORE the mic can hear it
    if (spoken !== text) this.noteForgeLine(spoken); // echo filter hears the spoken form
    this.ttsSpeaking = true;
    useStore.setState({ orbSpeaking: true, listeningActive: false });
    try {
      if (!this.health.tts || this.cancelled) throw new Error("tts off");
      await this.elevenSpeak(spoken);
    } catch {
      if (!this.cancelled) await this.browserSpeak(spoken);
    }
    this.ttsSpeaking = false;
    this.ttsTailUntil = Date.now() + 2_000;
    useStore.setState({ orbSpeaking: false });
    setTimeout(() => this.startRecog(), 300);
  }

  private cancelSpeech(): void {
    speechSynthesis.cancel();
    this.currentTtsAbort?.abort();
    if (this.currentAudio) { try { this.currentAudio.pause(); } catch { /* noop */ } this.currentAudio = null; }
    this.currentTtsFinish?.(); // settle the playback promise NOW, not at the watchdog
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
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (!text) continue;
          this.clearInterim();
          // Chrome re-fires already-final results across engine restarts —
          // an identical final within a couple of seconds is the same speech.
          const norm = normalizeSpeech(text);
          const now = Date.now();
          if (this.lastVoiceFinal && this.lastVoiceFinal.norm === norm && now - this.lastVoiceFinal.at < 2500) continue;
          this.lastVoiceFinal = { norm, at: now };
          // Recognition stays alive while Forge speaks so a participant can
          // barge in. During TTS — and the tail window right after, while
          // Chrome finalizes what it heard during playback — only explicit
          // control speech is accepted (addressed asks and stop commands), to
          // avoid treating Forge's own narration as meeting speech.
          if (!this.inTtsTail() || isAddressed(text) || this.isStopCommand(text)) {
            this.handleUtterance(text, "voice");
          }
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim.trim()) this.showInterim(interim.trim());
    };
    // ALWAYS restart while the mic is on — including mid-TTS. Chrome ends
    // recognition on its own every so often; refusing to restart during
    // playback used to leave Forge deaf (and uninterruptable) for the rest of
    // a long answer.
    r.onend = () => {
      if (this.recogWanted) setTimeout(() => { try { r.start(); } catch { /* already started */ } }, 250);
    };
    return r;
  }

  // ---------- live "Forge is hearing you" feedback ----------
  // Finals arrive seconds after you stop talking; without interim feedback,
  // saying "Forge, …" feels like talking to a wall. As soon as the live
  // (unfinalized) transcript addresses Forge, a caption mirrors it back.
  private interimAddressed = false;
  private interimTimer: ReturnType<typeof setTimeout> | undefined;

  private showInterim(text: string): void {
    if (!useStore.getState().ccOn) return;
    if (!this.interimAddressed && !isAddressed(text)) return;
    this.interimAddressed = true;
    useStore.setState({ caption: { speaker: `${this.myName} → Forge`, text: `${text} …`, visible: true } });
    clearTimeout(this.capTimer); // don't let an old caption timer hide us
    clearTimeout(this.interimTimer);
    // If the engine never finalizes (mic cut, long pause), fade the mirror.
    this.interimTimer = setTimeout(() => this.clearInterim(true), 5000);
  }

  private clearInterim(hide = false): void {
    if (!this.interimAddressed) return;
    this.interimAddressed = false;
    clearTimeout(this.interimTimer);
    if (hide) this.hideCaption();
  }

  /** True when this utterance means "cut it out": explicit stop phrases
   * anywhere, or a bare "stop"/"wait"-style word while Forge is active. */
  private isStopCommand(text: string): boolean {
    if (STOP.test(text)) return true;
    const forgeActive = this.agentBusy || this.remoteAgentActive || this.ttsSpeaking || useStore.getState().presenting;
    return forgeActive && BARE_STOP.test(text);
  }

  private startRecog(): void {
    if (!this.recog || !this.recogWanted) return;
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
    this.setStage("hand");
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
  /** The ack line every run opens with — receipt is never in doubt. */
  private ackFor(invited: boolean): string {
    if (invited) return "Sure — give me a moment to pull this together.";
    const acks = [
      "Got it — let me dig in.",
      "On it — one moment.",
      "Good question — let me check the repo.",
    ];
    return acks[Math.floor(Math.random() * acks.length)];
  }

  /** Hold a prepared answer until the team gives Forge the floor — but never
   * forever: after a polite wait it starts on its own. An indefinitely-held
   * "ready" would block the whole ask queue behind a missed chime. */
  private readyPause(maxWaitMs = 15_000): Promise<void> {
    return new Promise((resolve) => {
      let released = false;
      this.readyRelease = () => { released = true; };
      const deadline = Date.now() + maxWaitMs;
      const tick = () => {
        if (this.cancelled || released || Date.now() >= deadline) {
          this.readyRelease = null;
          resolve();
          return;
        }
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    });
  }

  private releaseReady(): void {
    this.readyRelease?.();
  }

  private async runAgent({ question = "", invited = false, reason = "", interrupted = false, taskId }: { question?: string; invited?: boolean; reason?: string; interrupted?: boolean; taskId?: string }): Promise<void> {
    if (this.agentBusy || this.remoteAgentActive) return;
    this.agentBusy = true;
    this.cancelled = false;
    this.lowerHand();
    useStore.setState({ listeningActive: false, thinkingTrace: [] });
    // Adopt the queued task from an interrupt, or register a fresh one.
    const existing = taskId ? useStore.getState().tasks.find((t) => t.id === taskId) : undefined;
    const task = existing ?? this.newTask("answer", question || (invited ? "Share a raised-hand thought" : "Answer the team"));
    if (TERMINAL_TASK.has(task.status)) { this.agentBusy = false; this.setListening(); return; } // cancelled while queued
    this.activeTaskId = task.id;
    this.setTask(task.id, { status: "working" });
    // Stage 1 — acknowledge receipt. The ack rides the agent-start cast so
    // BOTH participants hear the same acknowledgment, not just the asker.
    const ackMsg = this.ackFor(invited);
    this.room?.cast({ k: "agent-start", ack: ackMsg });
    this.setStage("working");
    this.agentAbort = new AbortController();

    try {
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
            this.traceLine(`\uD83D\uDD0D ${t.name}: ${t.input.slice(0, 80)}`);
          } else if (msg.type === "step") {
            // A parsed step is not a finished answer \u2014 steps are buffered and
            // played after "done", so the stage stays "working" until then.
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
        if (!this.cancelled) {
          // Stage 3 — ready: raise the hand, chime, and wait for a polite
          // gap (or an explicit "go ahead") before taking the floor.
          this.setStage("ready");
          this.setTask(this.activeTaskId, { status: "ready" });
          this.chime(0.5);
          this.room?.cast({ k: "agent-ready" });
          await this.readyPause();
        }
        useStore.setState({ thinkingTrace: [] });
        this.setTask(this.activeTaskId, { status: "presenting" });
        // Auto-layout the whole answer against the live board: the model's
        // coordinates are hints; this pass removes every overlap before
        // anything is drawn (and before ops are cast to the peer).
        const laidOut = this.wb ? layoutSteps(this.wb.layoutState(), preparedSteps) : preparedSteps;
        for (const step of laidOut) {
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
      this.setTask(this.activeTaskId, { status: this.cancelled ? "cancelled" : "error" });
      if (!this.cancelled) {
        const line = "I can't reach my backend brain right now — is the server still running?";
        this.caption("Forge", line, true);
        this.transcript("Forge", line);
        await this.speak(line);
      }
    } finally {
      this.setTask(this.activeTaskId, { status: this.cancelled ? "cancelled" : "done" });
      this.activeTaskId = null;
      this.room?.cast({ k: "agent-end" });
      useStore.setState({ thinkingTrace: [] });
      this.hideCaption();
      this.agentBusy = false;
      this.readyRelease = null;
      this.setListening();
      this.agentAbort = null;
      this.buffer = [];
      this.drainAskQueue(250);
    }
  }

  /** Run the next queued ask once Forge is free. Queued asks that arrived
   * mid-presentation run with interrupted context when that run was cut off. */
  private drainAskQueue(delayMs = 250): void {
    if (!this.askQueue.length) return;
    setTimeout(() => {
      if (this.agentBusy || this.remoteAgentActive) return; // something else took the floor
      const next = this.askQueue.shift();
      if (!next) return;
      const task = useStore.getState().tasks.find((t) => t.id === next.taskId);
      if (task && TERMINAL_TASK.has(task.status)) { this.drainAskQueue(50); return; }
      void this.runAgent({ question: next.text, interrupted: this.cancelled, taskId: next.taskId });
    }, delayMs);
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
      // Attributed nodes no longer auto-open the code stage — hovering a node
      // reveals a "view code" button instead (BoardCard → stageFromBoard).
    }
    this.caption("Forge", step.say, true);
    this.transcript("Forge", step.say);
    this.setStage(step.ops?.length ? "presenting" : "speaking");
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

  /** An ask that arrives while Forge holds the floor joins the queue and runs
   * right after — the current presentation is NOT killed. ("stop" kills it.) */
  private queueAsk(text: string): void {
    const task = this.newTask("answer", text);
    this.askQueue.push({ text, taskId: task.id });
    this.chime(0.25);
    this.caption("Forge", `Queued for after this: “${text.slice(0, 70)}”`);
  }

  /** Stop the current run. Queued asks survive by default — they were
   * explicit requests; `flushQueue` (\"cancel everything\") drops them too. */
  cancelAgent(flushQueue = false): void {
    this.room?.cast({ k: "cancel" });
    this.cancelled = true;
    this.setTask(this.activeTaskId, { status: "cancelled" });
    if (flushQueue) {
      for (const queued of this.askQueue) this.setTask(queued.taskId, { status: "cancelled" });
      this.askQueue = [];
    }
    this.agentAbort?.abort();
    this.walkthroughAbort?.abort();
    this.cancelSpeech();
    this.wb?.finishNow();
    this.exitPresenting();
    this.setListening();
    useStore.setState({ thinkingTrace: [] });
    this.drainAskQueue(600);
  }

  // ---------- background GitHub flows (issue creation, issue → PR) ----------
  // These never hold the floor: they run alongside answers/presentations,
  // reporting progress through the task registry and speaking only their
  // start and outcome.

  /** Read a streamed NDJSON response, invoking onMsg per parsed line. */
  private async readNdjson(res: Response, onMsg: (msg: Record<string, unknown>) => void): Promise<void> {
    const reader = res.body!.getReader();
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
        try { onMsg(JSON.parse(line) as Record<string, unknown>); } catch { /* junk line */ }
      }
    }
  }

  private async speakLine(text: string): Promise<void> {
    this.caption("Forge", text, true);
    this.transcript("Forge", text);
    this.room?.cast({ k: "step", say: text, ops: [] });
    await this.speak(text);
  }

  /** Start issue creation unless an equivalent command is already in flight
   * (repeated speech finals, an impatient re-ask seconds later). */
  private startIssueFlow(command: string): void {
    const norm = normalizeSpeech(command);
    const now = Date.now();
    this.recentIssueCommands = this.recentIssueCommands.filter((c) => now - c.at < 30_000);
    const tokens = new Set(norm.split(" "));
    for (const recent of this.recentIssueCommands) {
      const other = new Set(recent.norm.split(" "));
      let overlap = 0;
      for (const t of tokens) if (other.has(t)) overlap++;
      if (overlap / new Set([...tokens, ...other]).size >= 0.6) return; // same intent, already running
    }
    this.recentIssueCommands.push({ norm, at: now });
    this.flowChain = this.flowChain.then(() => this.runIssueFlow(command)).catch(() => {});
  }

  private async runIssueFlow(command: string): Promise<void> {
    const task = this.newTask("issue", `GitHub issue: ${command}`, "working");
    const abort = new AbortController();
    this.flowAborts.set(task.id, abort);
    const context = useStore.getState().transcript
      .filter((line) => line.who !== "Forge" && line.text !== command)
      .slice(-12);
    void this.speakLine("On it — I'll dig through the repo and file that issue. Give me a minute.");
    try {
      const res = await apiFetch(`${API}/api/github/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ command, transcript: context, idempotencyKey: crypto.randomUUID().replace(/-/g, "") }),
      });
      if (!res.ok || !res.body) throw new Error(`issue flow ${res.status}`);
      let issue: { html_url?: string; number?: number; title?: string; duplicate?: boolean } | null = null;
      let errorMsg: string | null = null;
      await this.readNdjson(res, (msg) => {
        if (msg.type === "progress") this.taskTrace(task.id, String(msg.text ?? ""));
        else if (msg.type === "tool") this.taskTrace(task.id, `🔍 ${msg.name}: ${String(msg.input ?? "").slice(0, 80)}`);
        else if (msg.type === "issue") issue = msg as typeof issue;
        else if (msg.type === "error") errorMsg = String(msg.message ?? "issue creation failed");
      });
      if (!issue) throw new Error(errorMsg ?? "issue creation failed");
      const done: { html_url?: string; number?: number; title?: string; duplicate?: boolean } = issue;
      this.lastIssueNumber = done.number ?? this.lastIssueNumber;
      this.setTask(task.id, { status: "done", label: `Issue #${done.number}: ${done.title ?? ""}` });
      // Careful: this line is heard by the mic. It must NOT contain a literal
      // trigger phrase ("work on issue N") or Forge can command itself.
      await this.speakLine(
        done.duplicate
          ? `Heads up — issue number ${done.number} already covers that: ${done.title}. I didn't file a duplicate.`
          : `Filed GitHub issue number ${done.number}: ${done.title}. I can pick it up and open a pull request whenever you ask.`
      );
    } catch (err) {
      if (abort.signal.aborted) return; // cancelled from the registry — stay quiet
      this.setTask(task.id, { status: "error" });
      const message = err instanceof Error ? err.message : "issue creation failed";
      await this.speakLine(`I couldn't create that GitHub issue: ${message}.`);
    } finally {
      this.flowAborts.delete(task.id);
    }
  }

  /** "Work on issue N": Forge reads the issue, implements it in an isolated
   * worktree on the backend, validates, then opens a pull request. */
  private startImplementFlow(number: number): void {
    const already = useStore.getState().tasks.some(
      (t) => t.kind === "pr" && !TERMINAL_TASK.has(t.status) && t.label.includes(`issue ${number}`)
    );
    if (already) return;
    this.flowChain = this.flowChain.then(() => this.runImplementFlow(number)).catch(() => {});
  }

  private async runImplementFlow(number: number): Promise<void> {
    const task = this.newTask("pr", `Pull request for issue ${number}`, "working");
    const abort = new AbortController();
    this.flowAborts.set(task.id, abort);
    void this.speakLine(`On it — I'll read issue ${number}, implement it, and open a pull request. This can take a few minutes; watch the task panel.`);
    try {
      const res = await apiFetch(`${API}/api/github/issues/${number}/implement`, {
        method: "POST",
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`implement flow ${res.status}`);
      let pr: { html_url?: string; number?: number; branch?: string; created?: boolean } | null = null;
      let errorMsg: string | null = null;
      await this.readNdjson(res, (msg) => {
        if (msg.type === "progress") this.taskTrace(task.id, String(msg.text ?? ""));
        else if (msg.type === "tool") this.taskTrace(task.id, `🛠 ${msg.name}: ${String(msg.input ?? "").slice(0, 80)}`);
        else if (msg.type === "pr") pr = msg as typeof pr;
        else if (msg.type === "error") errorMsg = String(msg.message ?? "implementation failed");
      });
      if (!pr) throw new Error(errorMsg ?? "implementation failed");
      const done: { html_url?: string; number?: number; branch?: string; created?: boolean } = pr;
      this.setTask(task.id, { status: "done", label: `PR #${done.number} for issue ${number}` });
      await this.speakLine(
        done.created
          ? `Done — pull request number ${done.number} is open for issue ${number}, on branch ${done.branch}. It passed validation; take a look when you get a chance.`
          : `Issue ${number} already has an open Forge pull request — number ${done.number}.`
      );
    } catch (err) {
      if (abort.signal.aborted) return;
      this.setTask(task.id, { status: "error" });
      const message = err instanceof Error ? err.message : "implementation failed";
      await this.speakLine(`I couldn't finish a pull request for issue ${number}: ${message}.`);
    } finally {
      this.flowAborts.delete(task.id);
    }
  }

  // ---------- utterance routing ----------
  handleUtterance(text: string, source: UtteranceSource): void {
    // Forge hearing itself must never enter the meeting record as a human
    // utterance. Stop commands are exempt so "stop talking" always works,
    // even mid-echo.
    if (source === "voice" && !this.isStopCommand(text) && this.isSelfEcho(text)) return;
    this.transcript(this.myName, text);
    this.room?.cast({ k: "utter", who: this.myName, text });

    if (CANCEL_ALL.test(text)) {
      this.cancelAgent(true);
      this.caption("Forge", "Dropped everything — back to you.");
      void this.speak("Dropped everything — back to you.");
      return;
    }
    if (this.isStopCommand(text)) {
      // Barge-in: kill the live explanation instantly; queued asks survive
      // and start after a beat (cancelAgent drains the queue).
      const wasActive = this.agentBusy || this.remoteAgentActive || this.ttsSpeaking;
      this.cancelAgent();
      if (!wasActive) { this.caption("Forge", "Sure — back to you."); void this.speak("Sure — back to you."); }
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
    // "work on issue 3" — runs in the background; never holds the floor.
    const implementNumber = parseImplementRequest(text, this.lastIssueNumber);
    if (implementNumber !== null) {
      this.startImplementFlow(implementNumber);
      return;
    }
    if (isIssueRequest(text)) {
      this.startIssueFlow(text);
      return;
    }

    // Check INVITE *before* direct address — "Forge, go ahead" invites rather than re-asks.
    if (INVITE.test(text) && (this.handRaised || useStore.getState().stage === "ready")) {
      this.acceptInvite();
      return;
    }

    if (source === "typed" || isAddressed(text)) {
      const question = source === "typed" ? text : stripAddress(text) || text;
      if (this.agentBusy || this.remoteAgentActive) {
        // Forge is mid-answer (ours or the peer's): don't kill it — queue the
        // new ask to run right after. "stop" is the explicit interrupt.
        this.queueAsk(question);
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
        useStore.setState({ handRaised: false, listeningActive: false, thinkingTrace: [] });
        this.setStage("working");
        // Both participants hear the same acknowledgment.
        if (ev.ack) {
          this.caption("Forge", ev.ack, true);
          this.transcript("Forge", ev.ack);
          void this.speak(ev.ack);
        }
        break;
      case "trace":
        // Mirror of the driver's working trace, so this side also sees what
        // Forge is doing while it prepares an answer.
        useStore.setState((s) => ({ thinkingTrace: [...s.thinkingTrace.slice(-11), ev.line] }));
        break;
      case "agent-ready":
        this.setStage("ready");
        this.chime(0.5);
        break;
      case "invite":
        // Peer said "go ahead" while OUR prepared answer was holding the floor.
        if (this.agentBusy) this.releaseReady();
        break;
      case "step":
        useStore.setState({ thinkingTrace: [] });
        // Skip queued steps if the run got cancelled while earlier ones
        // played. The catch keeps one bad step from wedging the chain (and
        // with it every future step, caption, and spoken line on this side).
        this.remoteChain = this.remoteChain
          .then(() => (this.cancelled ? undefined : this.playStep({ type: "step", say: ev.say, ops: ev.ops })))
          .catch(() => {});
        break;
      case "agent-end":
        this.remoteChain = this.remoteChain
          .then(() => {
            this.remoteAgentActive = false;
            this.hideCaption();
            this.setListening();
            // Anything we queued while the peer's run held the floor goes now.
            this.drainAskQueue(400);
          })
          .catch(() => {});
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
        this.drainAskQueue(600);
        break;
      case "board-clear":
        this.wb?.clear();
        this.boardOps = [];
        this.boardMoves = [];
        break;
      case "hand":
        this.handReason = ev.reason;
        useStore.setState({ handRaised: ev.raised });
        if (ev.raised) this.setStage("hand");
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
        // Late joiner: bring the shared repo stage up to where the room is.
        if (ev.stage) {
          void this.stageFile(ev.stage, { highlight: ev.stage.highlight ?? null });
        }
        break;
      case "focus":
        this.ensureFocus(ev.file, ev.startLine, ev.endLine);
        break;
      case "code-panel-open":
        void this.stageFile({ file: ev.file, startLine: ev.startLine, endLine: ev.endLine });
        break;
      case "code-panel-close":
        this.stage = null;
        useStore.setState({ codePanelOpen: false });
        break;
      case "task":
        // Peer's task upsert — mirror it (never re-cast someone else's task).
        this.upsertTask({ ...ev.task, mine: false }, false);
        break;
      case "task-cancel": {
        // Peer asks us to cancel one of OUR tasks.
        const target = useStore.getState().tasks.find((t) => t.id === ev.id);
        if (target?.mine) this.cancelTask(ev.id);
        break;
      }
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
    // Chimes are Forge's sounds too — scale with (and mute at) its volume.
    const vol = useStore.getState().forgeVolume;
    if (vol <= 0.01) return;
    gain *= vol;
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
    const vol = useStore.getState().forgeVolume;
    if (vol <= 0.01) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.04 * vol, t0 + 0.01);
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

  // Secret demo shortcut: pressing "0" anywhere in the room (any participant)
  // makes Forge deliver its scripted hello to the whole call. Ignored while
  // typing in the chat panel or any other text field.
  private onDemoKey = (e: KeyboardEvent): void => {
    if (e.key !== "0" || e.repeat) return;
    if (useStore.getState().phase !== "room") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    void this.speakLine("Hello hack the six, I'm Forge and I am here with Adam, and Efe, my creators!");
  };

  async join(name?: string): Promise<void> {
    if (this.joined) return; // Join button is once-guarded
    this.joined = true;
    this.myName = (name || "").trim() || "You";
    useStore.setState({ phase: "room", myName: this.myName });
    window.addEventListener("keydown", this.onDemoKey);

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
    const s = useStore.getState();
    const stage: StageSync | undefined = s.codePanelOpen && this.stage
      ? { ...this.stage, highlight: s.codePanelHighlight ?? undefined }
      : undefined;
    if (!this.boardOps.length && !stage) return;
    this.room?.cast({ k: "board-sync", ops: this.boardOps, moves: this.boardMoves, stage });
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

  /** Forge's voice volume — applies to the playing line, future lines, and chimes. */
  setForgeVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v));
    useStore.setState({ forgeVolume: vol });
    try { localStorage.setItem("forge-volume", String(vol)); } catch { /* private mode */ }
    if (this.currentAudio) this.currentAudio.volume = vol;
  }

  /** Remote peer's volume — Tiles applies it to the peer video element. */
  setPeerVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v));
    useStore.setState({ peerVolume: vol });
    try { localStorage.setItem("forge-peer-volume", String(vol)); } catch { /* private mode */ }
  }

  togglePanel(): void {
    useStore.setState((s) => ({ panelOpen: !s.panelOpen }));
  }

  closePanel(): void {
    useStore.setState({ panelOpen: false });
  }

  /** "Go ahead" — start a raised-hand run, or release a prepared answer
   * (our own directly, a peer's via the invite cast). */
  private acceptInvite(): void {
    if (this.agentBusy) { this.releaseReady(); return; }
    if (this.remoteAgentActive) { this.room?.cast({ k: "invite" }); return; }
    void this.runAgent({ invited: true, reason: this.handReason });
  }

  handClick(): void {
    this.acceptInvite();
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

  // ---------- shared repo stage ----------
  /** Fetch a file window around the target and put it on the stage. Returns
   * false (and changes nothing) when the file is missing or the backend is
   * unreachable — a bad reference must never break the meeting. */
  private async stageFile(
    target: { file: string; startLine?: number; endLine?: number },
    opts: { highlight?: { start: number; end: number } | null } = {}
  ): Promise<boolean> {
    const params = new URLSearchParams({ path: target.file });
    // Pad the window so the referenced lines sit in context, not at the very top.
    params.set("start", String(Math.max(1, (target.startLine ?? 1) - 12)));
    if (target.startLine != null) params.set("end", String((target.endLine ?? target.startLine) + 24));
    try {
      const res = await apiFetch(`${API}/api/repo/file?${params}`);
      if (!res.ok) return false;
      const data = (await res.json()) as { path: string; startLine: number; lines: string[]; githubUrl?: string };
      // The backend anchors the link to the padded fetch window — point it at
      // the exact referenced lines instead.
      const githubUrl = data.githubUrl && target.startLine != null
        ? data.githubUrl.replace(/#L\d+(-L\d+)?$/, `#L${target.startLine}${target.endLine ? `-L${target.endLine}` : ""}`)
        : data.githubUrl;
      this.stage = target;
      useStore.setState({
        codePanelOpen: true,
        codePanelFile: data.path,
        codePanelLines: data.lines,
        codePanelStartLine: data.startLine,
        codePanelGithubUrl: githubUrl ?? null,
        codePanelHighlight: opts.highlight !== undefined
          ? opts.highlight
          : target.startLine != null
            ? { start: target.startLine, end: target.endLine ?? target.startLine }
            : null,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Open the shared code stage for a board item (the hover "view code"
   * button) — stages the file for both participants, no spoken walkthrough. */
  stageFromBoard(target: { file: string; startLine?: number; endLine?: number }): void {
    void this.stageFile(target).then((ok) => {
      if (!ok) return; // missing file — leave the meeting undisturbed
      this.room?.cast({ k: "code-panel-open", file: target.file, startLine: target.startLine, endLine: target.endLine });
    });
  }

  /** Walkthrough focus: highlight in place when the lines are already loaded,
   * otherwise re-stage a window around them (including file switches). */
  private ensureFocus(file: string, start: number, end: number): void {
    const s = useStore.getState();
    const sameFile = !file || s.codePanelFile === file;
    const lastLoaded = s.codePanelStartLine + s.codePanelLines.length - 1;
    if (s.codePanelOpen && sameFile && start >= s.codePanelStartLine && end <= lastLoaded) {
      useStore.setState({ codePanelHighlight: { start, end } });
      return;
    }
    const targetFile = file || s.codePanelFile;
    if (!targetFile) return;
    void this.stageFile({ file: targetFile, startLine: start, endLine: end });
  }

  openCodePanel(attr: { file: string; startLine?: number; endLine?: number }, nodeLabel = "this component"): void {
    void this.stageFile(attr).then((ok) => {
      if (!ok) return; // missing file — no panel, no walkthrough, no cast
      this.room?.cast({ k: "code-panel-open", file: attr.file, startLine: attr.startLine, endLine: attr.endLine });
      // The walkthrough runs only here, on the side that clicked — the peer
      // mirrors it through step/focus casts, so it never runs twice.
      void this.runWalkthrough(nodeLabel, attr);
    });
  }

  closeCodePanel(): void {
    this.stage = null;
    useStore.setState({ codePanelOpen: false });
    this.room?.cast({ k: "code-panel-close" });
  }

  async runWalkthrough(nodeLabel: string, attr: { file: string; startLine?: number; endLine?: number }): Promise<void> {
    const board = this.wb ? this.wb.summary() : { title: null, nodes: [], arrows: [] };
    // Viewing code is user-initiated navigation, not a Forge task. It should
    // never appear in the task registry or expose tool calls elsewhere.
    const abort = new AbortController();
    this.walkthroughAbort = abort;
    // Keep Forge visibly working while the walkthrough loads, without making
    // this user-initiated code view a task.
    const wasIdle = !this.agentBusy && !this.remoteAgentActive;
    if (wasIdle) {
      useStore.setState({ thinkingTrace: [] });
      this.setStage("working");
    }
    try {
      const res = await apiFetch(`${API}/api/agent/walkthrough`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
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
            const msg = JSON.parse(line) as { type: string; say?: string; ops?: AgentStep["ops"]; file?: string; startLine?: number; endLine?: number; name?: string; input?: string };
            if (msg.type === "tool") {
              // Deliberately hidden: this is code-panel navigation, not a
              // task Forge volunteered to perform.
            } else if (msg.type === "step") {
              useStore.setState({ thinkingTrace: [] });
              await this.playStep({ type: "step", say: msg.say ?? "", ops: msg.ops }, true);
            } else if (msg.type === "focus") {
              const hl = { start: msg.startLine ?? 1, end: msg.endLine ?? msg.startLine ?? 1 };
              this.ensureFocus(msg.file ?? "", hl.start, hl.end);
              this.room?.cast({ k: "focus", file: msg.file ?? "", startLine: hl.start, endLine: hl.end });
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch { /* silently fail — walkthrough is best-effort */ } finally {
      this.walkthroughAbort = null;
      if (wasIdle && !this.agentBusy && !this.remoteAgentActive) {
        useStore.setState({ thinkingTrace: [] });
        this.setListening();
      }
    }
  }

  /** Draw a scripted sample board without the backend — exercises every op
   * type so the renderer can be demoed (and eyeballed) in isolation. */
  private demoBoard(): void {
    useStore.setState({ phase: "room", presenting: true });
    setTimeout(() => {
      this.wb?.clear();
      this.wb?.enqueue([
        { op: "title", text: "How Forge answers a question" },
        { op: "node", id: "mic", label: "Mic + Speech", sub: "Web Speech API", x: 190, y: 210, color: "#4166d5" },
        { op: "node", id: "sess", label: "ForgeSession", sub: "frontend/src/lib", x: 480, y: 210, color: "#7c4fd0" },
        { op: "arrow", from: "mic", to: "sess", label: "utterance" },
        { op: "node", id: "api", label: "POST /api/agent", sub: "NDJSON stream", x: 800, y: 210, color: "#c2453e" },
        { op: "arrow", from: "sess", to: "api", label: "question" },
        { op: "node", id: "claude", label: "Claude agent", sub: "backend brain", x: 1050, y: 400, color: "#e8862c" },
        { op: "arrow", from: "api", to: "claude" },
        { op: "node", id: "board", label: "Whiteboard", sub: "canvas renderer", x: 480, y: 490, color: "#279c94" },
        { op: "arrow", from: "claude", to: "board", label: "ops", bow: 30 },
        { op: "code", id: "wbcode", x: 300, y: 640, file: "frontend/src/lib/whiteboard.ts", line: 148, text: "export class Whiteboard {\n  readonly camera = new Camera();" },
        { op: "note", text: "steps buffered until 'done',\nthen played with voice", x: 810, y: 520 },
        { op: "circle", target: "board" },
      ]);
    }, 350);
  }

  end(): void {
    window.removeEventListener("keydown", this.onDemoKey);
    this.room?.close();
    this.room = null;
    this.recogWanted = false;
    this.stopRecog();
    this.cancelSpeech();
    this.agentAbort?.abort();
    this.walkthroughAbort?.abort();
    this.stream?.getTracks().forEach((t) => t.stop());
    useStore.setState({ phase: "ended" });
  }
}

export const session = new ForgeSession();
