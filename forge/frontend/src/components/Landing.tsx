// Landing: Rox-inspired editorial marketing page — warm near-black, hairline
// grid framing, huge Instrument Serif headlines with champagne-gold accents,
// masked line reveals, and an infinite stack marquee. The hero is the REAL
// product running live: the actual Whiteboard engine draws scripted boards
// stroke-by-stroke while a director loop types the transcript and streams
// tool-call trace lines, exactly like a working meeting.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { Whiteboard } from "../lib/whiteboard";
import type { WhiteboardOp } from "../types";

function CircleArrow({ tone = "dark" }: { tone?: "dark" | "gold" | "bone" }) {
  const stroke = tone === "dark" ? "#171310" : tone === "gold" ? "#c9a466" : "#efe7d8";
  return (
    <svg className="lx-circarr" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="8.25" stroke={stroke} strokeOpacity="0.55" strokeWidth="1" />
      <path d="M6.2 9h5.4m0 0L9.4 6.8M11.6 9l-2.2 2.2" stroke={stroke} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One headline line that reveals by sliding up out of an overflow mask. */
function MaskLine({ children, delay }: { children: React.ReactNode; delay: number }) {
  return (
    <span className="lx-mask">
      <span className="lx-mline" style={{ animationDelay: `${delay}s` }}>{children}</span>
    </span>
  );
}

const STACK = [
  { t: "WebRTC", style: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700 } },
  { t: "Claude", style: { fontFamily: "'Instrument Serif', serif", fontSize: 22 } },
  { t: "three.js", style: { fontFamily: "'Geist Mono', monospace" } },
  { t: "REACT", style: { fontFamily: "'Outfit', sans-serif", fontWeight: 300, letterSpacing: "0.2em" } },
  { t: "vite", style: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontStyle: "italic" } },
  { t: "zustand", style: { fontFamily: "'Geist', sans-serif", fontWeight: 600 } },
  { t: "TypeScript", style: { fontFamily: "'Geist', sans-serif", fontWeight: 500 } },
  { t: "Web Speech", style: { fontFamily: "'Geist Mono', monospace", letterSpacing: "0.08em" } },
] as const;

// ————— live hero: scripted meeting scenarios played by the real engine —————
interface Scenario {
  ask: string;
  answer: string;
  trace: string[];
  after: string[];
  chunks: WhiteboardOp[][];
}

const SCENARIOS: Scenario[] = [
  {
    ask: "Should the retry queue live in front of the worker?",
    answer: "Buffer retries in a queue so the worker drains them idempotently — like this.",
    trace: ['⌕ grep "retry" backend/src', "≣ read webhook.ts:41", "✎ planning the diagram"],
    after: ["✓ filed issue #12 — queue idempotency", "⎇ opened PR #13 · fix/retry-queue"],
    chunks: [
      [
        { op: "title", text: "Webhook retry path" },
        { op: "node", id: "hook", label: "Webhook", sub: "POST /hooks/pay", x: 190, y: 220, color: "#4166d5" },
        { op: "node", id: "api", label: "API", sub: "backend/src", x: 490, y: 220, color: "#7c4fd0" },
        { op: "arrow", from: "hook", to: "api", label: "event" },
      ],
      [
        { op: "node", id: "queue", label: "Retry Queue", sub: "idempotency key", x: 800, y: 220, color: "#e8862c" },
        { op: "arrow", from: "api", to: "queue", label: "enqueue" },
      ],
      [
        { op: "node", id: "worker", label: "Worker", sub: "drains + dedupes", x: 800, y: 480, color: "#279c94" },
        { op: "arrow", from: "queue", to: "worker", bow: 24 },
        { op: "note", text: "replay-safe:\nsame key → same result", x: 430, y: 480 },
        { op: "circle", target: "queue" },
      ],
    ],
  },
  {
    ask: "Can you sketch how a question becomes an answer?",
    answer: "Mic to session to the agent — steps buffer until done, then play with my voice.",
    trace: ['⌕ glob "src/lib/**"', "≣ read session.ts:176", "✎ planning the diagram"],
    after: ["✓ appended to meeting notes", "✋ waiting for the floor"],
    chunks: [
      [
        { op: "title", text: "How Forge answers" },
        { op: "node", id: "mic", label: "Mic + Speech", sub: "Web Speech API", x: 200, y: 230, color: "#4166d5" },
        { op: "node", id: "sess", label: "ForgeSession", sub: "frontend/src/lib", x: 510, y: 230, color: "#7c4fd0" },
        { op: "arrow", from: "mic", to: "sess", label: "utterance" },
      ],
      [
        { op: "node", id: "brain", label: "Claude agent", sub: "backend brain", x: 820, y: 230, color: "#c2453e" },
        { op: "arrow", from: "sess", to: "brain", label: "question" },
      ],
      [
        { op: "node", id: "board", label: "Whiteboard", sub: "canvas renderer", x: 510, y: 490, color: "#279c94" },
        { op: "arrow", from: "brain", to: "board", label: "ops", bow: 28 },
        { op: "note", text: "steps buffered until 'done',\nthen played with voice", x: 850, y: 490 },
        { op: "circle", target: "board" },
      ],
    ],
  },
];

/** The hero's live product frame: a real Whiteboard instance driven by a
 * looping director — transcript types in, tool calls stream, the pen draws. */
function LiveRoom() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capWhoRef = useRef<HTMLSpanElement>(null);
  const capTextRef = useRef<HTMLSpanElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wb = new Whiteboard(canvasRef.current!);
    let alive = true;
    let visible = true;
    let raf = 0;

    const io = new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; }));
    io.observe(rootRef.current!);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const setChip = (mode: "listening" | "working" | "presenting") => {
      const chip = chipRef.current;
      if (!chip) return;
      chip.className = `lx-live-chip ${mode}`;
      chip.textContent = mode === "working" ? "working…" : mode;
      badgeRef.current?.classList.toggle("show", mode === "presenting");
    };

    const setSpeaker = (who: "EFE" | "FORGE") => {
      const el = capWhoRef.current;
      if (!el) return;
      el.textContent = who;
      el.className = `lx-cap-who ${who === "FORGE" ? "forge" : ""}`;
    };

    const typeInto = async (text: string, cps = 32) => {
      const el = capTextRef.current;
      if (!el) return;
      el.parentElement?.classList.remove("hide");
      el.textContent = "";
      for (let i = 0; i < text.length && alive; i++) {
        el.textContent = text.slice(0, i + 1);
        await sleep(1000 / cps);
      }
    };

    const hideCaption = () => capTextRef.current?.parentElement?.classList.add("hide");

    const pushTrace = (line: string) => {
      const box = traceRef.current;
      if (!box) return;
      const row = document.createElement("p");
      row.className = "lx-tr";
      row.textContent = line;
      box.appendChild(row);
      while (box.children.length > 4) box.removeChild(box.children[0]);
    };

    const clearTrace = () => { if (traceRef.current) traceRef.current.innerHTML = ""; };

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    void document.fonts.ready.then(() => {
      if (!alive) return;

      if (reduced) {
        // Static tableau: the finished first scenario, no loops.
        SCENARIOS[0].chunks.forEach((c) => wb.enqueue(c));
        wb.finishNow();
        setChip("presenting");
        setSpeaker("FORGE");
        if (capTextRef.current) capTextRef.current.textContent = SCENARIOS[0].answer;
        SCENARIOS[0].trace.forEach(pushTrace);
        wb.frame(1 / 60);
        return;
      }

      let last = performance.now();
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (visible) wb.frame(dt);
      };
      raf = requestAnimationFrame(loop);

      // Director: one meeting beat per scenario, forever.
      void (async () => {
        let i = 0;
        await sleep(1400);
        while (alive) {
          const sc = SCENARIOS[i++ % SCENARIOS.length];
          wb.clear();
          clearTrace();
          setChip("listening");
          setSpeaker("EFE");
          if (capTextRef.current) capTextRef.current.textContent = "";
          await sleep(1100);
          await typeInto(sc.ask, 36);
          if (!alive) return;
          await sleep(600);
          setChip("working");
          for (const t of sc.trace) { pushTrace(t); await sleep(800); }
          await sleep(500);
          setChip("presenting");
          setSpeaker("FORGE");
          const speaking = typeInto(sc.answer, 26);
          for (const chunk of sc.chunks) { wb.enqueue(chunk); await sleep(3400); }
          await speaking;
          await sleep(3000);
          hideCaption();
          for (const t of sc.after) { await sleep(1700); pushTrace(t); }
          await sleep(4200);
        }
      })();
    });

    return () => { alive = false; cancelAnimationFrame(raf); io.disconnect(); };
  }, []);

  return (
    <div className="lx-live" ref={rootRef}>
      <div className="lx-live-board">
        <canvas ref={canvasRef} />
        <span className="lx-live-badge" ref={badgeRef}>✎ Forge is presenting</span>
        <div className="lx-live-cap">
          <span className="lx-cap-who" ref={capWhoRef}>EFE</span>
          <span className="lx-cap-text" ref={capTextRef} />
        </div>
      </div>
      <aside className="lx-live-rail">
        <div className="lx-live-tile">
          <span className="lx-live-avatar">E</span>
          <span className="lx-live-name">Efe <i>(you)</i></span>
        </div>
        <div className="lx-live-tile lx-live-forge">
          <span className="lx-live-orb" />
          <span className="lx-live-chip listening" ref={chipRef}>listening</span>
          <span className="lx-live-name">Forge · AI Engineer</span>
        </div>
        <div className="lx-live-trace" ref={traceRef} />
      </aside>
    </div>
  );
}

const COMMANDS = [
  {
    ask: "Forge, sketch the auth flow.",
    does: "A hand-drawn diagram grows on the shared whiteboard while Forge talks through it — auto-laid-out, collision-free, anchored to the decision.",
    k: "LIVE DIAGRAM",
  },
  {
    ask: "Forge, open an issue for the webhook bug.",
    does: "Forge explores the repo first, reconciles what it heard against the code, then files a deep, sectioned GitHub issue — deduped against the tracker.",
    k: "GITHUB ISSUE",
  },
  {
    ask: "Forge, take a crack at issue #7.",
    does: "A jailed coding agent branches, patches, typechecks, and opens the pull request — link dropped in the room before the call ends.",
    k: "PULL REQUEST",
  },
] as const;

export default function Landing() {
  const [leaving, setLeaving] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const shotRef = useRef<HTMLDivElement>(null);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => useStore.setState({ phase: "prejoin" }), 620);
  };

  const scrollTo = (id: string) => {
    pageRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scroll effects: reveal .rv elements once, and untilt the hero shot from
  // 22° to ~5° over the first 520px of scroll (rAF-coalesced).
  useEffect(() => {
    const root = pageRef.current!;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { root, threshold: 0.16 }
    );
    root.querySelectorAll(".rv").forEach((el) => io.observe(el));

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const untilt = () => {
      raf = 0;
      const p = Math.min(1, root.scrollTop / 520);
      shotRef.current?.style.setProperty("--tilt", `${22 - p * 17}deg`);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(untilt); };
    if (!reduced) root.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); root.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div id="landing" className={leaving ? "leaving" : ""}>
      <div className="grain" />
      <div className="lx-page" ref={pageRef}>

        <nav className="lx-nav">
          <span className="lx-wordmark"><i className="lx-star">✦</i>FORGE</span>
          <div className="lx-nav-links">
            <button onClick={() => scrollTo("product")}>Product</button>
            <button onClick={() => scrollTo("copilot")}>Copilot</button>
            <button onClick={() => scrollTo("workflow")}>Workflow</button>
          </div>
          <div className="lx-nav-actions">
            <button className="lx-pill lx-goldline" onClick={enter}>Try Now <CircleArrow tone="gold" /></button>
          </div>
        </nav>

        <header className="lx-hero">
          <div className="lx-arcs" aria-hidden />
          <h1 className="lx-h1">
            <MaskLine delay={0.1}>The Engineer</MaskLine>
            <MaskLine delay={0.24}>in <em>the Room</em>.</MaskLine>
          </h1>
          <p className="lx-caption rl" style={{ animationDelay: "0.55s" }}>
            Repo-Aware <i>|</i> Live Whiteboard <i>|</i> Raises Its Hand
          </p>
          <div className="lx-cta-row rl" style={{ animationDelay: "0.68s" }}>
            <button className="lx-pill lx-fill" onClick={enter}>Enter the Room <CircleArrow tone="dark" /></button>
            <button className="lx-pill lx-line" onClick={() => scrollTo("product")}>See It Work</button>
          </div>
        </header>

        <section className="lx-product" id="product">
          <div className="lx-shot-frame rl-shot" ref={shotRef}>
            <LiveRoom />
            <div className="lx-shot-glow" aria-hidden />
          </div>
        </section>

        <section className="lx-logos rv">
          <p className="lx-caption">Forged With the Best Tools</p>
          <div className="lx-marquee" aria-hidden>
            <div className="lx-marquee-track">
              {[...STACK, ...STACK, ...STACK, ...STACK].map((s, i) => (
                <span key={i} style={s.style as React.CSSProperties}>{s.t}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="lx-copilot" id="copilot">
          <div className="lx-copilot-head">
            <h2 className="lx-h2 lx-gold-tint rv">Your AI engineering copilot</h2>
            <p className="lx-lede rv">
              All of your context lives in the call — the repo, the whiteboard, the
              conversation. Ask Forge a question in plain speech and it answers out
              loud, sketching architecture live while it talks.
            </p>
          </div>
          <div className="lx-copilot-grid">
            {[
              {
                icon: <path d="M4 16.5L14.5 6a2.1 2.1 0 013 3L7 19.5 3.5 20.5 4 16.5z" />,
                h: "Sketches Live Architecture",
                p: "Boxes, queues, and arrows appear on the shared whiteboard as Forge speaks — every diagram anchored to the decision being made.",
              },
              {
                icon: <path d="M6 4h9a3 3 0 013 3v13l-4-2.5L10 20V7a3 3 0 00-3-3H6zm0 0v13" />,
                h: "Answers From Your Repo",
                p: "Forge reads the codebase before it joins. Questions get answers grounded in your actual files, not generic advice.",
              },
              {
                icon: <path d="M8 20v-7.5M8 12.5V5a1.5 1.5 0 013 0v5m0-2.5a1.5 1.5 0 013 0V10m0-1a1.5 1.5 0 013 0v5.5a5.5 5.5 0 01-5.5 5.5H11a5 5 0 01-4.4-2.6L4.3 13a1.4 1.4 0 012.4-1.3L8 13.5" />,
                h: "Raises Its Hand",
                p: "It never talks over you. When Forge has something worth saying, it raises its hand and waits for the floor.",
              },
            ].map((f, i) => (
              <article className="lx-cell rv" key={f.h} style={{ transitionDelay: `${i * 0.09}s` }}>
                <span className="lx-icon-chip">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#efe7d8" strokeOpacity="0.85" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{f.icon}</svg>
                </span>
                <h3>{f.h}</h3>
                <p>{f.p}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lx-work" id="workflow">
          <div className="lx-case-head">
            <h2 className="lx-h2 rv"><span className="lx-gold">Say it.</span><br />Watch it ship.</h2>
            <p className="lx-lede rv">
              Forge turns the words spoken in a meeting into the artifacts that
              outlive it — diagrams, issues, and pull requests, all before the
              call ends.
            </p>
          </div>
          <div className="lx-work-grid">
            {COMMANDS.map((c, i) => (
              <article className="lx-work-cell rv" key={c.k} style={{ transitionDelay: `${i * 0.1}s` }}>
                <p className="lx-work-k">{c.k}</p>
                <p className="lx-work-ask">“{c.ask}”<span className="lx-caret" /></p>
                <hr />
                <p className="lx-work-does">{c.does}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lx-cta" id="cta">
          <h2 className="lx-h1 lx-h1-sm rv">Put an engineer<br />in <em>every room</em>.</h2>
          <div className="rv" style={{ transitionDelay: "0.1s" }}>
            <button className="lx-pill lx-fill" onClick={enter}>Enter the Room <CircleArrow tone="dark" /></button>
          </div>
          <div className="lx-cta-panel rv" style={{ transitionDelay: "0.18s" }}>
            <span className="lx-cta-mark">✦</span>
          </div>
        </section>

        <footer className="lx-footer">
          <div className="lx-foot-grid">
            <div className="lx-foot-brand">
              <span className="lx-wordmark"><i className="lx-star">✦</i>FORGE</span>
              <p>The engineer in the room. Built in a weekend, listening in every meeting.</p>
            </div>
            {[
              { h: "Product", links: ["Live Room", "Whiteboard", "Task Registry", "Code Panel"] },
              { h: "Company", links: ["About", "Research", "Careers", "Contact"] },
              { h: "Resources", links: ["Docs", "GitHub", "Changelog", "Status"] },
            ].map((c) => (
              <div className="lx-foot-col" key={c.h}>
                <p className="lx-foot-h">{c.h}</p>
                {c.links.map((l) => <button key={l} onClick={enter}>{l}</button>)}
              </div>
            ))}
          </div>
          <div className="lx-foot-base">
            <span>© 2026 FORGE — TORONTO</span>
            <span className="lx-foot-tags">P2P · WEBRTC <i>|</i> REPO-AWARE <i>|</i> RAISES ITS HAND</span>
          </div>
        </footer>

      </div>
    </div>
  );
}
