# Skill: Engine-First Debugging (Placement/Render)

## When to use
Anything that "looks wrong" in Pixi grid: wrong cell, wrong stacking, wrong flip.

## Procedure
1) Inspect state:
   - Find the item in `world.items` and record `defId, x, y, footprint, flipped`.
2) Confirm engine legality rules:
   - locate `canPlaceAt` (or equivalent) and list relevant constraints.
3) Confirm LLM mirror:
   - locate `canFitAt` (or equivalent) and verify parity.
4) Confirm renderer mapping:
   - find where `(x,y)` becomes pixel coordinates.
   - ensure renderer does not rewrite `x,y` for gameplay reasons.
5) Build a Truth Table:
   - use `.cursor/templates/truth_table.md`
6) Fix in correct layer:
   - if state is wrong -> fix engine placement choice / reducer
   - if state is right but draw wrong -> fix renderer math or atlas baseline (pixel nudge)

## Forbidden fixes
- snapping item to a different grid cell in renderer
- adding placement restrictions only in runtime/LLM
