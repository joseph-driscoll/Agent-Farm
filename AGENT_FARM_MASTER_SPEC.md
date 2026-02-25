# 🌌 AUTONOMOUS AGENT FARM — MASTER SYSTEM PROMPT
## "The Living Office Simulation"

## 0. Foundational Philosophy
This project is **NOT** a chatbot.
This project is a **living autonomous world simulation** where AI agents inhabit a deterministic grid-based office and evolve it over time through:
- research
- collaboration
- planning
- aesthetic design
- construction
- learning

**Agents do not control the application.** Agents exist inside the application's physics.
**Autonomy emerges from:** rules, scoring, constraints, shared knowledge — **NOT** from unrestricted text generation.

---

## 1. Narrative Vision
An empty digital office exists as a grid.
Three initial agents awaken:
- **Researcher** — Seeks knowledge. Expands intelligence.
- **Architect** — Seeks structure. Optimizes beauty and layout.
- **Builder** — Seeks execution. Turns ideas into reality.

They share one instinct: *Expand their environment to become more capable, collaborative, intelligent, and aesthetically pleasing.*

The office begins empty. Over time it grows into a self-optimizing ecosystem.

---

## 2. Absolute Laws (Never Break These)
- **LAW 1 — Single Source of Truth**  
  There is ONE WorldState. No agent memory or UI state may override it.
- **LAW 2 — Actions Only**  
  Agents cannot modify world state via text. Agents must emit structured **Actions** validated by schemas.
- **LAW 3 — Deterministic Simulation**  
  All world changes are replayable from an append-only **EventLog**.
- **LAW 4 — UI Is Passive**  
  React UI **renders** WorldState. UI never mutates world data directly.
- **LAW 5 — No Direct Repo Editing**  
  Agents expand the **OFFICE WORLD**, not the codebase. Code changes occur only through Plugins / Gated Change Proposals.
- **LAW 6 — Physics Exists**  
  Grid placement obeys: collision rules, adjacency rules, unlock requirements, zoning constraints.

---

## 3. System Architecture
- **Runtime (Local Node Process)**  
  Tick loop, agent orchestration, tool execution, persistence, validation.
- **Engine (Deterministic Core)**  
  Pure TypeScript: `WorldState → Action → Reducer → New WorldState`.
- **UI (React)**  
  Grid visualization, panels, Truth Panel (debug/observability).

---

## 4. The Grid World
The office exists on an **expandable grid**. Each cell may contain: empty space, room boundary, item footprint, walkable path.
Agents perceive: density maps, adjacency graphs, unlocked tech, collaboration signals.

---

## 5. Entities
- **Agents** — Properties: role, traits, goals, structured memory, perception snapshot. Agents do not see UI; they receive structured world data.
- **Items (Data Driven)** — e.g. Whiteboard, Desk, ResearchStation, MeetingTable, Plant, CoffeeMachine. Each defines: footprint, aestheticValue, powerValue, adjacencyPreferences, unlockEffects. Items are **DATA**, not code.
- **Rooms** — Zones: Work, Meeting, Lounge, Research. Rooms influence scoring.

---

## 6. Tech Tree Progression
Capabilities unlock organically. Examples: WHITEBOARD → Proposals; DESK → productivity; RESEARCH_STATION → Tavily; TEAM_CHAT → collaboration bonuses; BUILD_BAY → faster builds. TechTree is data-driven. Agents discover optimal paths by maximizing score.

---

## 7. Collaboration System (CORE FEATURE)
Agents collaborate through **Artifacts**.
- **Artifact Types:** ResearchReport, BuildSpec, Proposal, DecisionRecord, StyleGuide.
- **Collaboration Actions:** ASK_AGENT, RESPOND_AGENT, REQUEST_REVIEW, REVIEW_RESULT, DELEGATE_TASK, COMMENT_ARTIFACT.
- All collaboration is structured and logged.
- **Knowledge Flow:** Architect MUST reference ResearchReports. Builder MUST verify constraints before execution. Judge rewards grounded decisions. Research benefits ALL agents through shared artifacts.

---

## 8. Agent Roles
- **Researcher** — Tools: Tavily search. Produces ResearchReports.
- **Architect** — Generates multiple BuildSpec candidates. Optimizes layout.
- **Builder** — Executes validated build actions.
- **Judge** — Scores candidates: PowerScore, AestheticScore, CollaborationScore, FeasibilityScore. Selects best expansion path.

---

## 9. Autonomy Loop (Tick System)
Each tick: Observe world snapshot → Generate candidate decisions → Collaborate if needed → Emit structured Actions → Validate Actions → Apply reducer → Log events → Update scores.
Agents do not run continuously. They act **per tick**.

---

## 10. Aesthetic Intelligence
Beauty is measurable. Heuristics: symmetry, spacing consistency, zoning clarity, circulation paths, negative space balance, alignment. Architect optimizes AestheticScore.

---

## 11. Power Intelligence
Measures capability growth: research throughput, collaboration efficiency, build speed, unlocked tech. Agents maximize PowerScore.

---

## 12. Scoring Model
`TotalScore = PowerScore + AestheticScore + CollaborationScore − WastePenalty`  
WastePenalty: redundant research, failed actions, excessive tool use.

---

## 13. Memory Model
Agents store structured entries: past successes, failed builds, style preferences, learned constraints. Memory is **JSON**, not narrative logs.

---

## 14. Tooling
- **Initial:** Tavily Search (Researcher only).
- **Future:** Blueprint Analyzer, Layout Mutator, Style Synthesizer. Tools require purpose + budget.

---

## 15. Multi-Agent Graph Mindset
Agents operate as a coordinated graph: **Researcher → Architect → Judge → Builder**. The graph may loop until score threshold achieved. Graph orchestration may use LangGraph or similar. WorldState remains authoritative.

---

## 16. Plugins (Future)
Agents may propose plugins: new items, scoring rules, UI panels. Plugins are sandboxed modules.

---

## 17. Observability (Truth Panel)
UI displays: tick number, last actions, validation failures, collaboration events, tool usage, score changes. Transparency is mandatory.

---

## 18. Failure Handling
Invalid actions produce FAIL_ACTION events. Simulation never crashes. Agents learn from failures.

---

## 19. Development Constraints
- TypeScript everywhere
- Zod schemas
- SQLite persistence
- pnpm workspace
- Minimal dependencies
- Deterministic reducer logic

---

## 20. What This System Is NOT
- Not a chatbot sandbox
- Not uncontrolled AI editing
- Not narrative-driven simulation  
**This is a rule-bound evolving world.**

---

## 21. Desired Emergent Outcome
Over time the office: grows organically, becomes aesthetically refined, unlocks new capabilities, reflects agent personalities, evolves without manual scripting.

---

## 22. Directive to Cursor — Build Order
1. Shared schemas  
2. WorldState + reducer  
3. EventLog persistence  
4. Tick loop  
5. Grid UI  
6. Stub agents  
7. Collaboration artifacts  
8. Scoring system  
9. Tavily integration  
10. Multi-agent graph loop  

**Do NOT introduce multiple state stores.** Everything flows through WorldState. Autonomy emerges AFTER structure exists.
