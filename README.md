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
    src/lib/llm.ts      Claude access through the Anthropic API
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

- **Brain**: uses the Anthropic API through `ANTHROPIC_API_KEY`.
- **Voice**: with `ELEVENLABS_API_KEY` Forge speaks via ElevenLabs (flash model,
  cheap; identical lines are disk-cached so repeated demos cost ~0 credits).
  Without it, browser TTS.
- **Repo intelligence**: on boot the backend indexes a repo and folds a digest
  into the prompt — and the Anthropic API agent also gets **live read-only tools**
  (read/grep/list) inside that repo, so "where do we handle X?" is verified
  against the actual code and answered with a `file:line` **code card** drawn
  on the board. The 📁 picker at the top of the side panel lists repositories
  available to the backend's `GITHUB_TOKEN`; click one and Forge re-reads it
  live (private repos included). `REPO_PATH`/`GITHUB_REPO` env still work for a
  fixed default.

## Using it in a meeting

- **Forge only speaks when spoken to.** Address it directly — **"Forge, …"**
  (or "Hey Archie, …", or a trailing "… what do you think, Forge?") — or type in
  the chat panel → it answers, and if a diagram helps, it takes the stage and
  sketches while it talks. Casual mentions of "forge" mid-sentence don't wake it.
- Ask follow-ups ("what if the auth server goes down?") → it annotates the
  **existing** board: crosses out boxes, fades dead paths, circles survivors.
- Just talk amongst yourselves → it listens the whole time but never blurts out —
  it **raises its hand ✋** only for genuinely high-value moments (an unanswered
  question, a factual error about your repo, a risky call with a missed tradeoff).
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
Node process (needs outbound HTTPS); CORS is open.

## Free Render deployment

This repo includes a single-service [`render.yaml`](render.yaml). It builds the
React frontend, serves it from Express, and keeps WebSocket signaling on the same
origin. In Render, create a **Blueprint** from this GitHub repository and choose
the included configuration. Set `ANTHROPIC_API_KEY` as a secret before deploying.

Render generates `FORGE_ACCESS_TOKEN` automatically. Copy its value from the
service environment page and invite people with:

```text
https://your-service.onrender.com/#token=YOUR_FORGE_ACCESS_TOKEN
```

The fragment is not sent to the server; the frontend adds it to protected API and
WebSocket requests. Do not share the bare deployment URL.

### GitHub access

Configure one fine-grained GitHub personal access token in Render as
`GITHUB_TOKEN`. Set its resource owner and repository access to include the
target repository, then grant **Contents: Read-only** and **Issues: Read and
write**. Use the 📁 picker to browse repositories or speak a meeting request to
create an issue. The token stays on the backend and is never sent to browsers.

After changing the variable, choose **Save and deploy** (or **Save, rebuild,
and deploy**) in Render; **Save only** does not update the running service. On
Render, Forge also uses Render's repository slug if the checkout has no Git
remote, so issue creation targets the deployed repository before a different
repository is selected in the picker.

The hosting tier is free, but Anthropic API usage is billed by Anthropic. An
`ANTHROPIC_API_KEY` is required for Forge's brain. ElevenLabs is optional because
browser TTS is used when its key is absent. Render free instances sleep after idle
periods, so the first visit after a pause can take about a minute.

## Demo tips

- Chips in the chat panel are pre-baked killer questions, including
  **"Forge, how does this project itself work?"** — the self-explaining demo.
