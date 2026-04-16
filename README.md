# CodexMap

Deployment metadata for the CodexMap architecture defined in [`design.md`](./design.md).

## Runtime Model

Render should run a **single Node web service** that:

- serves the browser UI over HTTP
- serves WebSocket traffic from the same service
- binds to `process.env.PORT` (Render-provided)

To stay aligned with `design.md`, keep the agent/orchestrator structure unchanged and only adapt runtime wiring for deployment (single-service HTTP + WS).

## Prerequisites

- Node.js `20.x` (matches Render runtime)
- npm `10+`

Using Node `24+` can cause native addon build failures for `tree-sitter` during install.

## Scripts

- `npm start`: runs the first available entrypoint in this order:
  `server.js` -> `orchestrator.js` -> `index.js`
- `npm run dev`: same startup flow with `NODE_ENV=development`
- `npm run start:render`: Render start alias that defaults `WS_PORT` to `PORT`
- `npm run track:init -- <folder>`: set the folder CodexMap should watch for files/nodes
- `npm run track:show`: print the currently tracked folder
- `npm run live:start -- --track <folder> [--prompt "..."]`: launch full multi-agent tracker session, set tracked folder, optionally set a Codex generation prompt, and open browser
- `npm run live:prompt -- "<prompt>"`: run Codex CLI (`codex exec`) against the currently tracked folder while agents keep updating the map

## Live Demo Flow

1. Export your key once (if you use API-key auth):
   - `export OPENAI_API_KEY=<your_key>`
   - or `export CODEX_API_KEY=<your_key>` (CodexMap bridges this to `OPENAI_API_KEY`).
2. Start full live session:
   - `npm run live:start -- --track /path/to/my-live-project --prompt "Build a small API with auth"`
3. Browser opens at `http://localhost:10000`.
4. For additional iterations while session stays running, issue new prompts:
   - `npm run live:prompt -- "Add pagination and tests"`
5. You can also edit files manually in that tracked folder; nodes/grades update live.

Notes:
- Multi-agent architecture stays the same (Cartographer, Broadcaster, Sentinel, Historian, Architect, Healer, Generator).
- Generator and Healer now use non-interactive `codex exec` so Codex runs reliably in agent processes.
- Cartographer runs an active scan loop every ~3.5s and UI pulls map-state every ~2.5s for robust live updates.

## Deploy On Render

This repo includes a Render Blueprint at [`render.yaml`](./render.yaml).

1. Create a new Render Blueprint service from this repository.
2. Render will use:
   - build command: `npm install`
   - start command: `npm run start:render`
3. Ensure your runtime code listens on `PORT` and exposes UI + WebSocket from the same Node service.

## Environment Variables

- `PORT`: HTTP port (required on Render; defaults to `10000` in blueprint)
- `WS_PORT`: optional override; defaults to `PORT` in `npm run start:render`
- `HOST`: bind host (`0.0.0.0`)
- `NODE_ENV`: `production` on Render

## Notes

- `Procfile` is included for platform compatibility (`web: npm start`).
- `.gitignore` excludes runtime-generated shared state and output artifacts from the design architecture.
