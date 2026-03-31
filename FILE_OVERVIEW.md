# Agent Farm File Overview

Fast map of the codebase for onboarding and code review.

## Top-level

| Path | Purpose |
|---|---|
| `README.md` | Product intro, setup, run commands |
| `AGENT_FARM_MASTER_SPEC.md` | High-level design and invariants |
| `FILE_OVERVIEW.md` | This quick code map |
| `scripts/` | Runtime entrypoint, tests, search proxy |
| `src/` | Engine, runtime, UI, config |

## `src/engine` (authoritative simulation core)

- `schemas.ts`: Zod schemas for world, agents, artifacts, actions
- `worldState.ts`: placement legality, helpers, constants
- `reducer.ts`: deterministic action application
- `navGrid.ts`: walkability + pathfinding helpers
- `scoring.ts`: power/aesthetic/collaboration/waste scoring

## `src/runtime` (backend + orchestration)

- `persistence.ts`: persistence adapter (JSONL or SQLite)
- `llm.ts`: prompt building, response parsing integration, dialogue filters
- `llmSchema.ts`: strict turn schema validation
- `agentRoles.ts`: per-role model + personality config
- `tavily.ts`: web research integration
- `pixellab.ts`: optional pixel-art generation integration
- `clientMotion.ts`, `steering.ts`, `posSync.ts`, `sendPos.ts`: movement and position sync

## `src/ui` (frontend)

- `App.tsx`: app shell, data fetching, live controls
- `GridViewPixi.tsx`: primary pixel renderer (agents/items/overlays)
- `GridView.tsx`: HTML fallback renderer
- `ActivityPanel.tsx`: chat/action feed
- `AgentInspectorPanel.tsx`: per-agent stats and artifacts
- `TruthPanel.tsx`: raw simulation/debug truth feed
- `PlaceItemTool.tsx`: manual placement UI

## `src/config` (data-driven visuals + build context)

- `spriteRegistry.ts`: sprite atlas registry and constants
- `officeAtlas.ts` / `workstationPieces.ts`: sprite region mappings
- `atlasBuildOrder.ts`: build-order and prompt support data

## Runtime scripts

| File | Purpose |
|---|---|
| `scripts/run-runtime.ts` | Main runtime server + scheduler + tick loop |
| `scripts/search-proxy.js` | Tavily proxy service |
| `scripts/test-placement.ts` | Placement legality tests |
| `scripts/test-reducer.ts` | Reducer behavior tests |
| `scripts/test-scheduler.ts` | Scheduler policy tests |

## Data flow (one-screen summary)

1. Runtime loads persisted events and reconstructs `WorldState`
2. Scheduler picks an agent turn and gets structured output (LLM/stub)
3. Reducer applies validated actions deterministically
4. Runtime persists events and broadcasts state over HTTP/WS
5. UI renders world and panels from the same source of truth

For setup and usage, see `README.md`.
