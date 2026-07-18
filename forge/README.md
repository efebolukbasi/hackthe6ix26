# Forge — where AI and human engineers work together

An AI engineering teammate that joins your meeting as an **active participant**: it
listens to the conversation, knows your repo, speaks with a real voice, and explains
architecture by **sketching live diagrams on a shared whiteboard** — paced so humans
can actually follow.

## Layout (deliberately split for independent deploys / parallel editing)

```
forge/
  backend/    Express + TypeScript API (Node 24 native TS — no build step)
    src/server.ts       routes + static hosting of ../frontend/dist
    src/lib/repo.ts     repo indexer → digest injected into the system prompt
    src/lib/prompt.ts   persona + whiteboard-op schema prompts
    src/lib/llm.ts      Claude access: ANTHROPIC_API_KEY (API) or `claude` CLI login
    src/lib/agent.ts    /api/agent — streams NDJSON steps {say, ops[]}; /api/listen
    src/lib/tts.ts      /api/tts — ElevenLabs proxy + disk cache (503 → browser TTS)
    src/lib/types.ts    shared types (WhiteboardOp union, AgentStep, …)
  frontend/   Vite + React 18 + TypeScript
    src/lib/whiteboard.ts   hand-drawn canvas engine; animates ops stroke-by-stroke
    src/lib/session.ts      ForgeSession — mic/speech/TTS/agent-stream/raise-hand logic
    src/state/store.ts      zustand UI state
    src/components/         PreJoin · Room · BoardCard · Tiles · Captions · ControlBar · SidePanel · Ended
```

## Run it

```bash
cd forge/backend && npm install && cd ../frontend && npm install && cd ../..
npm start        # from repo root: builds the frontend, starts the backend → http://localhost:5180
```

(Or equivalently from the repo root: `npm --prefix forge/backend install` etc. —
the `--prefix` paths are relative to wherever you run them.)

Development (hot reload): `npm run dev:backend` + `npm run dev:frontend`
(Vite on :5173 proxies /api → :5180). Optional voice: `cp forge/backend/.env.example forge/backend/.env` and paste `ELEVENLABS_API_KEY`.

Open http://localhost:5180 in **Chrome**, allow mic/cam, Join.

- **Brain**: uses `ANTHROPIC_API_KEY` if set; otherwise shells out to your local
  `claude` CLI login. No key needed on a machine with Claude Code.
- **Voice**: with `ELEVENLABS_API_KEY` Forge speaks via ElevenLabs (flash model,
  cheap; identical lines are disk-cached so repeated demos cost ~0 credits).
  Without it, browser TTS.
- **Repo intelligence**: on boot the backend indexes a repo and folds a digest
  into the prompt — and in CLI mode Forge also gets **live read-only tools**
  (Grep/Read/Glob) inside that repo, so "where do we handle X?" is verified
  against the actual code and answered with a `file:line` **code card** drawn
  on the board. **Switching repos is a login, not config**: the 📁 picker at the
  top of the side panel lists your GitHub repos — click one and Forge re-reads it
  live (private repos included). Login is zero-click when the host has `gh`
  logged in (or `GITHUB_TOKEN` set); otherwise set `GITHUB_CLIENT_ID` and the
  picker offers device-flow login (enter a short code on github.com).
  `REPO_PATH`/`GITHUB_REPO` env still work for a fixed default.

## Using it in a meeting

- Say **"Forge, …"** (or "Archie") or type in the chat panel → it answers, and if a
  diagram helps, it takes the stage and sketches while it talks.
- Ask follow-ups ("what if the auth server goes down?") → it annotates the
  **existing** board: crosses out boxes, fades dead paths, circles survivors.
- Just talk amongst yourselves → it listens passively and **raises its hand ✋**
  when it has something valuable (e.g. you claim Redis pub/sub is durable).
  Say "go ahead" or click the hand to let it speak.
- **Interrupt it**: say "Forge, actually…" (or type) mid-presentation — it stops,
  adjusts, and continues from the board it already drew. "stop presenting" /
  "thanks Forge" halts it entirely; "clear the board" wipes it.
- It answers non-technical questions too, in plain speech — diagrams only appear
  when they genuinely help.

## Two-person calls (P2P)

Forge calls now hold **two humans + Forge**. Audio/video flows browser-to-browser
(WebRTC, STUN only — true P2P); the backend's `/ws` endpoint handles signaling and
keeps Forge state (transcript, whiteboard steps, raise-hand) in sync on both sides.

To invite someone outside your network:

```bash
npm run tunnel     # public https URL → send it to your friend
```

They open the URL in Chrome, enter a name, Join — done. (HTTPS is required for
their mic/cam, which the tunnel provides.) Wear headphones on both ends, or the
mics will transcribe each other's speakers. Only one hand-raise "driver" runs at
a time (the first joiner), so Forge won't interject twice.

## Split deployment

Frontend is pure static files — host anywhere (Vercel/Netlify/S3) and set
`window.FORGE_API = "https://your-backend"` in `config.js`. Backend is a single
Node process (needs outbound HTTPS + optionally a `claude` login); CORS is open.

## Demo tips

- Chips in the chat panel are pre-baked killer questions, including
  **"Forge, how does this project itself work?"** — the self-explaining demo.
- The `poc/` folder keeps the original scripted proof-of-concept for reference.
