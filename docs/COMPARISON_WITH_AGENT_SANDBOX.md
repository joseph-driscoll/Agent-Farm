# Agent Farm vs Agent Sandbox

## TL;DR

| | **Agent Farm** | **Agent Sandbox** |
|---|---|---|
| **Core architecture** | Deterministic `WorldState` + reducer + event log | Multi-store app state (harder to replay) |
| **Runtime behavior** | LLM/stub turns, live movement, chat, artifacts, scoring | LLM-centric interactive behaviors |
| **Debuggability** | Strong replay/audit trail | Strong interactive feel, weaker replay model |

Agent Farm keeps the simulation disciplined while still feeling alive.

---

## 1. Architecture

### Agent Farm (right way)

- **Single source of truth:** One `WorldState` (grid, cells, items, agents, artifacts, scores, tick). UI only reads it.
- **Actions only:** All changes go through structured `Action` (Zod) and the **reducer**. No free-form text mutating state.
- **Deterministic:** Event log (JSONL or SQLite) replays to reconstruct state. No hidden UI state.
- **Clear layers:** Engine (pure TS) → Runtime (tick loop, persistence, HTTP) → UI (render only).

### Agent Sandbox (messy but lively)

- **Many stores:** `agentStore`, `officeElementStore`, `whiteboardStore`, `chatLogStore`, `llmStore`, `sharedMemoryStore`, `contributionStore`, `worldStore`, etc. Hard to reason about and easy for UI and “world” to get out of sync.
- **Mixed mutation:** LLM output drives steering and chat; stores are updated from many places (think loop, actions, UI).
- **No event log:** You can’t replay the sim from a single log. Debugging is “what’s in the stores right now?”
- **Rich loop:** `useThinkLoop` runs per agent, calls LLM with context (nearby agents, whiteboard, chat, memory), parses thought/say/action/propose/work, pushes to ChatLog, sets action for steering.

---

## 2. What made Sandbox feel alive

These are the patterns Sandbox emphasized:

1. **Movement**
   - Agents have `x, y, vx, vy`. Every frame, `actionToSteering()` turns their current action (e.g. `go_to_whiteboard`, `hold`) into velocity; steering combines with separation/cohesion; positions update.
   - So they **walk** toward desks, whiteboard, build site, lounge, or wander when holding.

2. **Talking**
   - LLM returns `say:` and `thought:`. Both get pushed to `ChatLogStore` and appear in the Activity panel and as **speech/thought bubbles** above agents in the canvas.
   - Other agents see “last say from another agent” in their context, so they can respond and coordinate.

3. **Learning from each other**
   - **Shared memory:** Entries appended when agents say/do things; every agent’s prompt includes recent shared memory.
   - **Long-term memory:** Summaries and lessons (e.g. “when stuck, go to whiteboard”) stored and injected into prompts.
   - **Research at desk:** When at desk, research (e.g. Tavily) is fetched and given to the LLM so Nova/Sage/Pixel “learn” and mention it in proposals/work.

4. **Collaborative workflow**
   - Whiteboard with proposals; agents approve/claim; Builder gets “current task” and goes to build site. All driven by LLM + stores + steering.

5. **Stuck detection and nudges**
   - If an agent repeats the same action or similar say/thought, the next prompt gets a nudge (“go to whiteboard to sync”) and shared memory gets a lesson.

## 3. What Farm emphasizes

- **Replay and audit:** Full history in the event log; same run can be reproduced.
- **No store soup:** One world, one reducer. Easier to add new action types and features without touching five stores.
- **Spec-aligned:** Deterministic sim, actions-only, tech tree, scoring, artifacts. Ready for multi-agent graph (Researcher → Architect → Judge → Builder) and future plugins.

## 4. Architecture-preserving approach

Everything that today is “store + LLM + UI” in Sandbox should become **WorldState + actions + reducer** in Farm.

| Sandbox “life” | In Farm (architecture-preserving) |
|----------------|------------------------------------|
| **Movement** | Add `vx, vy` to agents (or derive). New action `UPDATE_AGENT_POSITION` (or `MOVE_AGENT`) emitted by runtime each physics step; reducer applies it. Replay = same positions. |
| **Say / thought** | New action `SAY` / `THOUGHT` (or `CREATE_ARTIFACT` type `Say`). WorldState has `chatLog: ChatEntry[]` (or `lastSays`). Reducer appends. UI reads from WorldState and draws bubbles. |
| **LLM in the loop** | Runtime: per tick, build world snapshot (agents, items, artifacts, recent chat). Call LLM; parse structured output (say, thought, action). Emit `SAY`, `THOUGHT`, and world-mutation actions (`PLACE_ITEM`, `CREATE_ARTIFACT`, etc.). All go through reducer and event log. |
| **Learning** | Agent `memory` already in schema. New action `APPEND_MEMORY`. Research = `CREATE_ARTIFACT` ResearchReport; prompts include artifacts + memory. Shared “lessons” = either artifacts or a small `sharedMemory` array in WorldState updated by action. |
| **Steering / physics** | Runtime runs a small physics loop (or sub-steps per tick): from current action and world, compute desired velocity; clamp; apply to position; emit `MOVE_AGENT` (or batch at end of tick). Reducer stays pure. |

Rules to keep:

- **No UI mutating world.** UI only renders WorldState (and fetches it from the runtime).
- **No “hidden” state.** If it affects behavior or display, it’s in WorldState and updated via actions.
- **Deterministic replay.** Every move, say, and thought is an event; replaying the log reproduces the same “movie.”

## 5. Implementation order (historical roadmap)

1. **Movement**
   - Add `vx`, `vy` (and optionally `targetX`, `targetY`) to agent schema. Add action `MOVE_AGENT(agentId, x, y)` or `UPDATE_AGENT_VELOCITY` + position update in reducer. Runtime: each tick, compute next position from current action (and simple steering if you want), emit move action(s). UI: render agents at `x, y` (already have coordinates; just need them to change over time).
2. **Chat in world**
   - Add `chatLog: { agentId, text, type: 'say'|'thought', tick }[]` to WorldState (capped length). Action `SAY` / `THOUGHT`. Reducer appends. UI: Truth Panel or side panel shows recent entries; grid view shows bubbles above agents (from last say/thought per agent).
3. **LLM-driven tick**
   - Replace stub `runStubAgents()` with: for each agent (or in graph order), build prompt from WorldState (agents, items, artifacts, chatLog, agent memory), call OpenAI/OpenRouter, parse say/thought/action, emit `SAY`, `THOUGHT`, and world actions. Tool use (e.g. Tavily) stays in runtime; results become `CREATE_ARTIFACT` ResearchReport.
4. **Memory and shared learning**
   - Use existing `agent.memory` and `APPEND_MEMORY` (or similar). Optionally add `sharedMemory: string[]` to WorldState and action `APPEND_SHARED_MEMORY` for “lessons” and cross-agent context. Prompts include memory + recent artifacts.

Once movement, chat, and LLM loop are in place, Farm will feel like Sandbox (agents move, talk, learn) but with a single WorldState, event log, and deterministic replay.
