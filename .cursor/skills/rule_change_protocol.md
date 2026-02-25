# Skill: Rule Change Protocol

## When to use
Any change to placement legality, constraints, occupancy, stacking rules.

## Required steps
1) Update engine: `canPlaceAt` + any helpers
2) Update runtime mirror: `canFitAt`
3) Update tests:
   - add at least 2 cases (allowed + disallowed)
4) Add a brief changelog note at top of modified file(s):
   - "2026-02-20: Changed workstation aisle rule to ..."
5) Confirm no UI hacks were introduced

## Validation
- Run tests
- Re-check invariants in `.cursor/rules.md`
