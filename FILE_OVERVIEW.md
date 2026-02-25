# Agent Farm — File Overview

A clean reference for what every file in the project does.  
**Agent Farm** is a living office simulation: AI agents (Researcher, Architect, Builder, Judge) inhabit a grid-based office and evolve it through research, collaboration, and construction.

---

## Root

| File | Purpose |
|------|--------|
| `package.json` | Scripts (dev, build, tests), dependencies (React, Pixi, Matter, Zod, ws, Tavily), optional SQLite. |
| `README.md` | Setup, ports, running the stack, LLM/stub mode, persistence, architecture summary. |

---

## Entry & App Shell

| File | Purpose |
|------|--------|
| `src/main.tsx` | React entry: mounts `CustomCursor` + `App` into `#root`, imports global CSS. |
| `src/vite-env.d.ts` | Vite + `*.json` module typings for TypeScript. |
| `src/ui/index.css` | Global styles: dark theme, custom-cursor body classes, layout, typography. |
| `src/ui/App.tsx` | Main app: fetches/polls world, WebSocket for live updates and pos sync; toggles grid/cell coords, place tool, delete mode; composes grid (Pixi or HTML), Controls, Activity, Agent Inspector, Place Item, Whiteboard, Truth Panel. |

---

## Engine (`src/engine/`)

Pure simulation logic — no Node/browser deps. Single source of truth: **WorldState**; all changes via **reducer**.

| File | Purpose |
|------|--------|
| `index.ts` | Re-exports schemas, worldState, navGrid, reducer, scoring. |
| `schemas.ts` | **Zod schemas** for grid, cells, items, agents, actions, events, artifacts, chat, memory. Single source of truth for structured data. |
| `worldState.ts` | Initial world, grid constants (e.g. `BACK_WALL_ROWS`, `BUILD_START_ROW`), **pure helpers**: placement rules (`canPlaceAt`, `getValidPlacementTiles`), item/agent/cell lookups, workstation/chair/computer logic, unlock/tech. |
| `reducer.ts` | **Deterministic reducer**: `(WorldState, Action, eventIndex) → new WorldState`. Handles all action types (MOVE_AGENT, PLACE_ITEM, SAY, CREATE_ARTIFACT, VOTE, research, memory, etc.). No side effects. |
| `navGrid.ts` | **Walkability layer**: build nav grid from world (walkable, cost, blockedBy). A* pathfinding (`findPath`), neighbor helpers. Used by reducer (MOVE_AGENT), steering, and UI. |
| `scoring.ts` | **Score heuristics**: power, aesthetic, collaboration, waste; `totalScore(world)`. Used for Judge/Architect and display. |

---

## Runtime (`src/runtime/`)

Node backend: tick loop, persistence, HTTP/WebSocket server, LLM and external APIs.

| File | Purpose |
|------|--------|
| `index.ts` | Re-exports persistence, search (Tavily), and agent graph order. |
| `persistence.ts` | **Persistence facade**: picks JSONL or SQLite (when `AGENT_FARM_USE_SQLITE=1`); `openDb`, `closeDb`, `loadWorldState`, `appendEvent`, `loadAllEvents`, `replayToState`. |
| `persistence-jsonl.ts` | Append-only **JSONL** event log (`agent-farm-events.jsonl`). No native deps; default when SQLite unavailable. |
| `persistence-sqlite.ts` | **SQLite** event log via `better-sqlite3`. Used when env flag set and native module installed. |
| `llm.ts` | **LLM client + prompt builder**: builds world snapshot, good next spots (from engine), conversation phase; calls model per agent turn; parses response into say/thought/action/placeItem/vote/research/memory. |
| `llmSchema.ts` | **Zod schemas** for LLM response parsing: placeItem, createArtifact, vote, researchQuery, extractUrls, crawl, remember, loadSkill; `parseAgentTurnResponse`. |
| `agentRoles.ts` | **Per-role config**: display names (Planner/Manager/Worker/Judge), OpenRouter model ids, **personality** strings for Researcher/Architect/Builder/Judge. |
| `graph.ts` | **Agent graph order**: `AGENT_GRAPH_ORDER` (Researcher → Architect → Judge → Builder); used by tick/scheduler. |
| `schedulerPolicy.ts` | **Who speaks next**: `pickRoundRobinIndexAvoidRepeat` — round-robin while avoiding repeating last speaker. |
| `tavily.ts` | **Tavily integration**: search (proxy or SDK), research (when API key set), extract, crawl. Used by Researcher agent. |
| `skillRegistry.ts` | **Skill loader**: reads YAML frontmatter + body from `skills/*.yaml`; catalog for prompts, full body when skill is loaded. |
| `clientMotion.ts` | **Client-side agent motion** (UI only): intent → target cell, pathfinding, interpolation; FSM (idle/pathing/approach_chair/seated). Syncs with server via WebSocket pos. |
| `steering.ts` | **Intent → target cell**: chair cells, walkable cells, hold/explore targets; `getTargetCellForIntent`; used by client motion and grid. |
| `sendPos.ts` | **Throttled WebSocket pos updates**: `maybeSendAgentPos(ws, agentId, x, y)`; prune cache by live agent ids. |
| `posSync.ts` | **Ephemeral agent positions**: apply WebSocket pos updates onto world for smooth display; `applyEphemeralAgentPositions(world, maxAgeMs)`. |

### Skills (`src/runtime/skills/`)

| File | Purpose |
|------|--------|
| `manager.routing.yaml` | Skill: Manager routing — turn plan into next tasks and assignments. |
| `planner.discovery.yaml` | Skill: Planner discovery / context gathering. |
| `planner.breakdown.yaml` | Skill: Spec-driven breakdown into tasks and artifacts. |
| `worker.implementation.yaml` | Skill: Worker implementation — safe patch workflow and execution. |

---

## UI (`src/ui/`)

React components; consume world from App and engine helpers.

| File | Purpose |
|------|--------|
| `GridView.tsx` | **HTML/CSS grid** (fallback when Pixi off): cells, items, agents, speech bubbles, movement trace; click-to-place, delete; optional grid lines and cell coords. |
| `GridViewPixi.tsx` | **Pixi.js canvas grid**: same game state as GridView but rendered with Pixi layers + sprites; agents, items, chairs, workstations, overlays. |
| `Controls.tsx` | **Top bar**: grid toggle, cell-coords toggle, copy logs, **LLM on/off**, Nuke (full reset). |
| `ActivityPanel.tsx` | **Left panel**: unified activity — chat (say) + pipeline actions (propose, vote, place) from `lastEvents`; filters; LLM vs stub styling. |
| `AgentInspectorPanel.tsx` | **Agent details**: selected agent stats, recent says, proposals, votes, reports; copy JSON; infer “feeling” from intent. |
| `PlaceItemTool.tsx` | **Place-item tool**: list of item defs (searchable), select def then click grid to place; used with App’s place flow. |
| `WhiteboardPanel.tsx` | **Right panel**: “Build” — explains turn rate (one agent per LLM response) and scheduler. |
| `TruthPanel.tsx` | **Truth panel**: last N events (reverse order), raw view of world/actions for debugging. |
| `CustomCursor.tsx` | **Custom cursor**: follow-mouse reticle; pointer state on clickable elements; body classes to hide default cursor. |

### Pixi helpers (`src/ui/pixi/`)

| File | Purpose |
|------|--------|
| `layers.ts` | **Pixi layer stack**: root, background, items, agents, foreground, overlays; zIndex and sortableChildren. |
| `spriteFactory.ts` | **Sprite creation**: texture cache, frame textures from `SpriteEntry` (sheet + region); `createSpriteFromEntry`; nearest-neighbor for pixel art. |

---

## Config (`src/config/`)

Data-driven layout, atlases, and build order for engine + LLM.

| File | Purpose |
|------|--------|
| `spriteRegistry.ts` | **Sprite registry**: loads `workstation_atlas.json` + `office_atlas.json`; maps defIds to sheet URL + region; agent sprites (body/hair), workstation top/bottom, floor slices; `CELL_PX`, `CELL_PX_Y`. |
| `workstationPieces.ts` | **Workstation slice regions** from `workstation_atlas.json`: top/bottom bounds; used by sprite registry and grid renderers. |
| `officeAtlas.ts` | **Role → agent frame name**: Researcher/Architect/Builder/Judge → `agent_analyst`, `agent_architect`, `agent_builder` for sprite lookups. |
| `atlasBuildOrder.ts` | **Build progression** and LLM context: `WORKSTATION_RULES_TEXT`, `PLACEABLE_DEF_IDS_ORDERED`, `BUILD_PROGRESSION`, office reference image URL; used by LLM prompts. |
| `workstation_atlas.json` | Workstation/office sprite slice definitions (Aseprite-style); imported by `spriteRegistry` and `workstationPieces`. |

---

## Shared & Logging

| File | Purpose |
|------|--------|
| `src/shared/coords.ts` | **Coordinate helpers**: engine (0,0 top-left, y down) ↔ display Y; `toDisplayY`, `toEngineY`. |
| `src/logger.ts` | **Central logging**: categorized (TICK, AGENT, LLM, etc.), timestamped, ring buffer; `getLogDump` for `/api/logs`. |

---

## Scripts (`scripts/`)

| File | Purpose |
|------|--------|
| `run-runtime.ts` | **Runtime server**: HTTP (GET /world, /api/*, /api/logs, nuke, llm-toggle) + WebSocket (/ws); tick loop, persistence, LLM/stub agents, Tavily; applies pos updates from WS. |
| `search-proxy.js` | **Tavily search proxy**: HTTP server (port 3010); forwards search to Tavily or Serper; used by UI/runtime when `VITE_SEARCH_API_URL` points here. |
| `test-placement.ts` | **Placement tests**: `canPlaceAt` for workstations, tables, coffee_maker, chairs, computers; run with `npm run test:placement`. |
| `test-reducer.ts` | **Reducer tests**: CREATE_ARTIFACT, PLACE_ITEM, executed proposal tracking, votes; run with `npm run test:reducer`. |
| `test-scheduler.ts` | **Scheduler tests**: `pickRoundRobinIndexAvoidRepeat`; run with `npm run test:scheduler`. |
| `sprite-sheet-size.js` | **Utility**: prints dimensions of `public/office-assets.png` (PNG header parse) for tuning sprite regions. |
| `office_atlas.json` | **Office atlas data**: frame positions for office sprites (used by spriteRegistry when office assets are used). |

---

## Config / Assets (reference)

| Path | Purpose |
|------|--------|
| `.cursor/rules/*.mdc` | Cursor rules: placement, sprite layers, project law. |
| `.cursor/agents/*.md` | Agent-specific prompts (Judge, Researcher, Builder, Architect). |
| `.cursor/prompts/*.md` | Task prompts (bug fix, feature, refactor, etc.). |
| `.cursor/checklists/*.md` | PR/engine/UI/LLM gates. |
| `.cursor/skills/*.md` | Cursor skills (regression, placement invariants, coordinate audit, etc.). |

---

## Data Flow (short)

1. **Engine**: `schemas` + `worldState` + `reducer` + `navGrid` + `scoring` define and evolve state.
2. **Runtime**: `run-runtime.ts` loads state from persistence, runs tick loop, calls LLM (or stub), appends actions, reduces, saves; serves HTTP + WS.
3. **UI**: App fetches world (and subscribes via WS), passes world into grid (Pixi or HTML), panels, and place tool; client motion + posSync for smooth agent movement.
4. **Config**: Atlases and build order drive both rendering (spriteRegistry, workstationPieces) and LLM prompts (atlasBuildOrder).

---

*Generated for the Agent Farm codebase. For setup and usage see `README.md`.*
