# Skill: Add Tests First

## When to use
Any behavior change (not pure styling).

## Procedure
1) Write failing test that expresses the desired behavior.
2) Implement minimal change.
3) Ensure test passes.
4) Add 1 regression test for a nearby edge case.

## Minimum requirements
- A "happy path" and a "blocked" case.
- Tests must target engine/reducer logic, not Pixi rendering.
