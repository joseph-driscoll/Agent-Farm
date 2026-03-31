# Agent Farm

Agent Farm is a living office simulation where AI teammates wake up in an empty room and slowly turn it into a functional, expressive workspace.

Nova researches. Sage plans. Pixel builds.  
They talk, propose, vote, place objects, and adapt as the space evolves.

Under the hood, every change still flows through deterministic world rules so the sim stays debuggable and replayable.

![Agent Farm live simulation](./docs/agent-farm-live.png)

## What you feel when it runs

- A real-time office that changes every few seconds
- Agents with distinct voices and responsibilities
- Visible collaboration: proposals, shipped items, research artifacts
- A simulation that feels alive without becoming chaotic

## Why the engineering matters

- **Deterministic core**: `WorldState` + reducer + event log replay
- **Guardrailed autonomy**: LLM-driven behavior constrained by engine legality
- **Single source of truth**: engine state, not UI hacks
- **Inspectability**: activity feed, truth panel, agent inspector, logs

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Run modes

| Command | What it runs |
|---|---|
| `npm run dev` | Runtime + UI (fastest local start) |
| `npm run dev:all` | Search proxy + runtime + UI |
| `npm run dev:runtime` | Runtime only (`3011`) |
| `npm run dev:ui` | UI only (`5173`) |
| `npm run search-proxy` | Tavily proxy only (`3010`) |
| `npm run build` | Typecheck + production build |

## Environment

Copy `.env.example` to `.env` and set what you need:

- `OPENAI_API_KEY` or `OPENROUTER_API_KEY`
- `USE_LLM=1` (optional; default is safe/off)
- `TAVILY_API_KEY` (optional; enables research tools)
- `PIXELLAB_API_TOKEN` (optional; enables PixelLab artifact generation)

## Ports

| Service | Port | Override |
|---|---:|---|
| Search proxy | `3010` | `SEARCH_PROXY_PORT` or `PORT` |
| Runtime API/WS | `3011` | `RUNTIME_PORT` |
| UI (Vite) | `5173` | set in `vite.config.ts` |

If you use search, set `VITE_SEARCH_API_URL` to match your proxy port.

## Architecture at a glance

- `src/engine`: deterministic placement rules, reducer, scoring
- `src/runtime`: scheduler, agent turns, LLM/tool orchestration, persistence, API/WS
- `src/ui`: React + Pixi grid renderer, activity feed, inspector, truth panel

## Persistence

- Default: append-only JSONL event log (`agent-farm-events.jsonl`)
- Optional: SQLite via `AGENT_FARM_USE_SQLITE=1` (`better-sqlite3`)

## Optional integrations

- **Tavily**: Researcher can search/extract/crawl and publish `ResearchReport` artifacts
- **PixelLab**: Architect/Builder can request character/tile/animation assets and publish `PixelArt` artifacts

## Notes for long runs

Runtime is local. If your machine sleeps, simulation pauses. Keep the machine awake for overnight runs.

## More docs

- System spec: `AGENT_FARM_MASTER_SPEC.md`
- Code map: `FILE_OVERVIEW.md`
- Comparison: `docs/COMPARISON_WITH_AGENT_SANDBOX.md`
