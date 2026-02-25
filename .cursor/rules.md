# Project Rules (Source of Truth)

These rules are non-negotiable. If a change conflicts with these rules, the change is wrong.

## 0) Operating Mode
- Prefer correctness over cleverness.
- Prefer deterministic state over "looks right" rendering hacks.
- Prefer small diffs and tests over large rewrites.
- Never "patch around" engine rules in UI.

## 1) Layer Ownership (Hard Boundaries)

### Engine (authoritative)
- Files: `src/engine/*`
- Owns:
  - placement legality (e.g. `canPlaceAt`, occupancy, footprints)
  - invariants and constraints (borders, aisle, wall rules)
  - derived helpers used by all layers (e.g. workstation helpers, flip rules)
- Must remain deterministic. No `Date.now()`, no randomness, no DOM.

### Reducer / State transitions (authoritative)
- Files: `src/engine/reducer.ts` (or equivalent reducer)
- Owns:
  - deterministic transitions from actions -> new state
  - auto-orientation logic only when action input is undefined (e.g. `flipped` defaulting)
- Never stores view-only pixel offsets.

### LLM Runtime (mirror-only)
- Files: `src/runtime/*` or `src/runtime/llm.ts`
- Role:
  - propose actions
  - validate proposals using mirror logic
- Constraints:
  - `canFitAt` must mirror engine `canPlaceAt` for all hard rules.
  - Never introduces new rules that the engine doesn't have.
  - Never "fixes" legality with extra constraints without engine parity.

### UI Rendering (render-only)
- Files: `src/ui/*`, `GridViewPixi.tsx`
- Role:
  - render exactly what is in state (world.items, world.agents)
  - can apply PIXEL nudges (purely visual), but must not move items to different grid cells to "fix" logic
- Forbidden:
  - reinterpreting item x/y to "snap" to another cell
  - adding placement/orientation logic that affects game rules
  - storing derived placement decisions outside engine

## 2) Coordinate Semantics (Invariant)
- Item `(x,y)` is the **top-left** cell of its footprint in world coordinates.
- Footprint `[w,h]` occupies:
  - `x..x+w-1`, `y..y+h-1`
- The renderer must draw the item anchored to the correct cell origin. Visual offsets are allowed only as pixel nudges.

## 3) Determinism (Invariant)
- Reducer and engine must be deterministic.
- No time-based logic in state transitions.
- Any randomization must be seeded and derived from world snapshot if absolutely necessary (prefer none).

## 4) Change Protocol (Required)
If you change any placement/legality rule:
1) Update engine (`canPlaceAt` or equivalent)
2) Update LLM mirror (`canFitAt` or equivalent)
3) Add/adjust tests for the rule
4) Add a short changelog note in the modified file(s)

If you change coordinate semantics:
1) Update engine helper(s)
2) Update renderer mapping
3) Update tests
4) Run an audit using the Coordinate Semantics skill

## 5) Tests (Required for Behavior Changes)
- Any behavior change requires tests.
- Minimum acceptable: a small test harness validating expected legality and placement.
- No "I tested manually" unless it is purely styling and visuals.

## 6) Outputs Required From Agents
Every agent response must include:
- A 1-page plan (before coding)
- A diff narrative (after coding)
- A test plan + what was run/added
- If placement/render bug: a Truth Table (template provided)

## 7) "Renderer Purity" Rule (Critical)
UI is not allowed to relocate items to different cells.
Examples of forbidden UI hacks:
- "If computer is in middle cell, draw it left if chair present"
- "If chair flipped, shift x by 1 cell"

All such logic must live in engine state or placement selection and be stored in world state.

## 8) Computers and Chairs (Special Rule)
Computers and chairs must be placed in **final cells by engine/state**.
- The renderer is **forbidden** from rewriting computer `drawX`/`drawY` based on desk/chair adjacency.
- If the computer should appear left or right of the desk, the **engine must store that x/y at placement time**.
- The renderer may apply only **pixel nudges** for baseline alignment.
