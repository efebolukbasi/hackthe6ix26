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
# from the repo root
npm --prefix forge/backend install
npm --prefix forge/frontend install
npm start        # builds the frontend, starts the backend → http://localhost:5180
```

Development (hot reload): `npm run dev:backend` + `npm run dev:frontend`
(Vite on :5173 proxies /api → :5180). Optional voice: `cp forge/backend/.env.example forge/backend/.env` and paste `ELEVENLABS_API_KEY`.

Open http://localhost:5180 in **Chrome**, allow mic/cam, Join.

- **Brain**: uses `ANTHROPIC_API_KEY` if set; otherwise shells out to your local
  `claude` CLI login. No key needed on a machine with Claude Code.
- **Voice**: with `ELEVENLABS_API_KEY` Forge speaks via ElevenLabs (flash model,
  cheap; identical lines are disk-cached so repeated demos cost ~0 credits).
  Without it, browser TTS.
- **Repo intelligence**: on boot the backend indexes `REPO_PATH` (defaults to this
  repo — the self-explaining demo) and folds a digest into the prompt.

## Using it in a meeting

- Say **"Forge, …"** (or "Archie") or type in the chat panel → it answers, and if a
  diagram helps, it takes the stage and sketches while it talks.
- Ask follow-ups ("what if the auth server goes down?") → it annotates the
  **existing** board: crosses out boxes, fades dead paths, circles survivors.
- Just talk amongst yourselves → it listens passively and **raises its hand ✋**
  when it has something valuable (e.g. you claim Redis pub/sub is durable).
  Say "go ahead" or click the hand to let it speak.
- "stop presenting" / "thanks Forge" interrupts it; "clear the board" wipes it.

## Split deployment

Frontend is pure static files — host anywhere (Vercel/Netlify/S3) and set
`window.FORGE_API = "https://your-backend"` in `config.js`. Backend is a single
Node process (needs outbound HTTPS + optionally a `claude` login); CORS is open.

## Demo tips

- Chips in the chat panel are pre-baked killer questions, including
  **"Forge, how does this project itself work?"** — the self-explaining demo.
- The `poc/` folder keeps the original scripted proof-of-concept for reference.
