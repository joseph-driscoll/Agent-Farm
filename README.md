# Agent Farm — Living Office Simulation

Autonomous world simulation: AI agents (Researcher, Architect, Builder, Judge) inhabit a deterministic grid-based office and evolve it through research, collaboration, and construction. Single source of truth (WorldState), action-only mutations, event-log persistence.

## Setup

- **Node 18+** (npm or pnpm)
- `.env`: reuse from agent-sandbox (OpenAI, OpenRouter, Tavily). Port overrides are optional (see Ports below).
- **Office pixel sprites:** Placements (desk, whiteboard, plant, etc.) use your pixel-art sheet. Run `npm run copy-office-assets` once to copy `assets/office-assets.png` (or `assets/office_assets.png`) → `public/office-assets.png`. Tweak regions in `src/config/officeSprites.ts` to match your sheet layout.

```bash
npm install
# or: pnpm install
```

## Ports

| Service        | Port | Env override   | Used by                    |
|----------------|------|---------------|----------------------------|
| **Search proxy** (Tavily) | 3010 | `SEARCH_PROXY_PORT` or `PORT` | Researcher (runtime calls `VITE_SEARCH_API_URL`) |
| **Runtime** (world API)   | 3011 | `RUNTIME_PORT`       | UI proxy `/api` → here     |
| **UI** (Vite)             | 5173 | in `vite.config.ts`  | Browser                    |

`VITE_SEARCH_API_URL` in `.env` must match the search proxy port (default `http://localhost:3010`).

## Running the stack

**Option A — One terminal (all services):**

```bash
cd agent-farm
npm run dev:all
# or: pnpm run dev:all
```

Starts, in one window:

- **search** (yellow) — Tavily proxy on **3010**
- **runtime** (cyan) — World state + tick loop on **3011**
- **ui** (magenta) — Vite on **5173**

Then open **http://localhost:5173**.

**Option B — Three terminals:**

1. **Terminal 1 — Search proxy**
   ```bash
   cd agent-farm && npm run search-proxy
   ```
   Leave running. You should see: `[search] http://localhost:3010/?q=...`

2. **Terminal 2 — Runtime**
   ```bash
   cd agent-farm && npm run dev:runtime
   ```
   Leave running. You should see: `[runtime] http://localhost:3011/world ...`

3. **Terminal 3 — UI**
   ```bash
   cd agent-farm && npm run dev:ui
   ```
   Then open **http://localhost:5173**.

**Option C — Backend only (no search):**

```bash
npm run dev
```

Runs runtime + UI only (no Tavily). Researcher reports will have empty search results.

## Scripts

| Command | Description |
|--------|-------------|
| `npm run dev:all` | Search proxy + runtime + UI (one terminal) |
| `npm run dev` | Runtime + UI (no search proxy) |
| `npm run dev:ui` | UI only (Vite, port 5173) |
| `npm run dev:runtime` | Runtime only (port 3011) |
| `npm run search-proxy` | Tavily search proxy (port 3010) |
| `npm run build` | Typecheck + Vite build |

(Same scripts work with `pnpm run` if you have pnpm installed.)

## Autonomous mode (LLM + Tavily)

**LLM is opt-in so the runtime does not burn API credits by default.** With an API key in `.env`, the runtime still runs in **stub** mode (scripted chat + building) until you enable LLM. The UI shows **"Stub mode — LLM off"** or **"LLM on"** in the header so you can see which mode is active.

- **Enable LLM (uses credits):** set `USE_LLM=1` or `AGENT_FARM_LLM=1` when starting the runtime (e.g. in `.env` or on the command line). One agent speaks per tick, so each LLM tick is **1 API call**.
- **Reduce cost:** set `LLM_EVERY_N_TICKS=2` or `3` so the API is only called every 2nd or 3rd tick; other ticks use stub behavior so you still see progress.
- **No API key / no USE_LLM:** runtime uses stub only (no API calls, no credits). The UI will show "Stub mode — LLM off".

Example: `USE_LLM=1 npm run dev:runtime` or add `USE_LLM=1` to `.env` and run `npm run dev:runtime`. Example with fewer credits: `USE_LLM=1 LLM_EVERY_N_TICKS=3 npm run dev:runtime` uses the LLM every 3rd tick.

## Overnight / long runs

The **runtime runs on your machine** (Node on port 3011). It is not a cloud service.

- **Sleep / idle:** When your computer sleeps or goes idle, the Node process is suspended and **no ticks run**. After wake-up, the first LLM calls often fail with **"fetch failed"** or **"timeout"** because the network connection was dropped. So you see a long gap (e.g. 9pm → 7am) with no progress, then "⚠️ fetch failed" when the sim tries again.
- **To run overnight:** Keep the computer **awake** (Power & sleep → Never, or use a "keep awake" tool). Or run the runtime on a machine that doesn’t sleep (e.g. a VPS or a dedicated dev machine with sleep disabled).

## Backend and persistence

The **runtime is the backend** (Node on port 3011): it runs the sim, persists the event log, and serves `/world`.

- **Default:** append-only **JSONL** file (`agent-farm-events.jsonl`). No native build, no Python — works everywhere.
- **Optional SQLite:** for a real DB, set `AGENT_FARM_USE_SQLITE=1` and ensure `better-sqlite3` is installed (it’s in `optionalDependencies`; if install fails due to missing Python/Build Tools, the app still runs with JSONL). On Windows, Node **22 LTS** often has prebuilt binaries so SQLite installs without building.

## Architecture

- **Engine** (`src/engine`): Zod schemas, WorldState, reducer (pure TS). No Node deps.
- **Runtime** (`src/runtime`): Node process (the **backend**) — tick loop, stub agents, event log, HTTP `GET /world`. Persistence: **JSONL by default** (`agent-farm-events.jsonl`, no native deps). Optional **SQLite** backend: set `AGENT_FARM_USE_SQLITE=1` and install build tools (or use Node 22 LTS for prebuilds); `better-sqlite3` is in `optionalDependencies` so `npm install` still succeeds if it can’t build.
- **UI** (`src/ui`): React — grid view, Truth Panel. Fetches world from `/api/world` (proxied to runtime).

## Build order (from spec)

1. Shared schemas ✅  
2. WorldState + reducer ✅  
3. EventLog persistence ✅  
4. Tick loop ✅  
5. Grid UI ✅  
6. Stub agents ✅  
7. Collaboration artifacts ✅  
8. Scoring ✅  
9. Tavily integration (search-proxy ✅; Researcher tool in runtime next)  
10. Multi-agent graph (stub loop ✅; full LLM graph next)

## Master spec

See [AGENT_FARM_MASTER_SPEC.md](./AGENT_FARM_MASTER_SPEC.md).
