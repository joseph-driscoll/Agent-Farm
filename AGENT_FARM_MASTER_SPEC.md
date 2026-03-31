# Agent Farm Master Spec

The definitive product intent for Agent Farm.

## Vision

Agent Farm is a rule-bound autonomous simulation, not a chatbot.  
AI agents live inside a deterministic office world and improve it through research, collaboration, and construction.

## Core principles

1. **Single source of truth**: one `WorldState`.
2. **Actions only**: all changes flow through typed `Action` objects.
3. **Deterministic replay**: simulation state is reproducible from event logs.
4. **Engine-first legality**: placement rules live in engine logic, not UI hacks.
5. **Render-only UI**: UI visualizes state and never mutates authoritative world rules.

## Architecture

- **Engine (`src/engine`)**: schemas, legality, reducer, scoring, nav.
- **Runtime (`src/runtime`)**: tick loop, orchestration, LLM/tools, persistence, API/WS.
- **UI (`src/ui`)**: live visualization, inspector, activity feed, truth panel.

## Agent roles

- **Researcher (Planner/Nova)**: gathers evidence, produces `ResearchReport` artifacts.
- **Architect (Manager/Sage)**: proposes structured build actions (`Proposal` artifacts).
- **Builder (Worker/Pixel)**: executes validated placements from proposals.
- **Judge**: evaluates decisions and quality metrics.

## Autonomy loop

Each tick:

1. Observe current world snapshot
2. Choose agent turn via scheduler policy
3. Generate structured turn output (LLM or stub)
4. Validate and apply actions via reducer
5. Persist events
6. Recompute scores
7. Broadcast world

## Scoring model

`Total = Power + Aesthetic + Collaboration - WastePenalty`

- **Power**: capability and productivity growth
- **Aesthetic**: layout quality and visual coherence
- **Collaboration**: healthy agent teamwork patterns
- **WastePenalty**: failed/spammy or redundant behavior

## Artifacts

Primary artifact types:

- `Proposal`
- `ResearchReport`
- `BuildSpec`
- `DecisionRecord`
- `StyleGuide`
- `PixelArt`

Artifacts are first-class, structured, and auditable.

## Determinism + safety requirements

- Reducer logic must remain deterministic.
- No hidden state that can diverge from replay.
- No engine rule drift between runtime suggestions and engine legality.
- Invalid operations emit `FAIL_ACTION` and do not crash the sim.

## Product outcome target

A simulation that feels alive at runtime while staying fully debuggable, reproducible, and explainable.
