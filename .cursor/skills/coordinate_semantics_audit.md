# Skill: Coordinate Semantics Audit

## When to use
Any time something is in "wrong cell" or footprints don't align.

## Audit questions
1) Is `(x,y)` top-left footprint everywhere?
2) Does occupancy computation match footprint math?
3) Does renderer assume a different anchor (center vs top-left)?
4) Are tall sprites using bottom-center anchor consistently?
5) Are multi-tile items (workstation) using container with correct local coords?

## Outputs required
- A list of all places where `(x,y)` is interpreted
- Confirmed semantics for each
- Any mismatches and the fix location
