# Forge — where AI and human engineers work together

An AI engineering teammate that joins your meeting as an **active participant**: it
listens to the conversation, knows your repo, speaks with a real voice, and explains
architecture by **sketching live diagrams on a shared whiteboard** — paced so humans
can actually follow.

## Layout (deliberately split for independent deploys / parallel editing)

```
forge/
  backend/    Node + Express API — the brain, the voice, the repo knowledge
    server.js         routes + static hosting of ../frontend for local dev
    lib/repo.js       repo indexer → digest injected into the system prompt
    lib/prompt.js     persona + whiteboard-op schema prompts
    lib/llm.js        Claude access: ANTHROPIC_API_KEY (API) or `claude` CLI login
    lib/agent.js      /api/agent — streams NDJSON steps {say, ops[]}; /api/listen
    lib/tts.js        /api/tts — ElevenLabs proxy + disk cache (503 → browser TTS)
  frontend/   Static meet-style web app (no build step)
    index.html        pre-join → call UI (tiles, captions, controls, chat panel)
    app.js            agent loop, speech recognition, raise-hand, voice playback
    whiteboard.js     hand-drawn canvas engine; animates ops stroke-by-stroke
    config.js         window.FORGE_API — point a static deploy at a remote backend
```

## Run it

```bash
cd forge/backend
cp .env.example .env       # paste ELEVENLABS_API_KEY (optional but 🔥 for demos)
npm install
npm start                  # → http://localhost:5180  (serves the frontend too)
```

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
