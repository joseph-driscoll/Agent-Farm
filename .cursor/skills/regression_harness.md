# Skill: Regression Harness

## Goal
Capture a world snapshot and ensure future changes don't break core invariants.

## Procedure
1) Create a fixed world snapshot (JSON) that includes:
   - multiple workstations
   - chairs left/right
   - computers on desks
   - a blocked border case
2) Add tests:
   - validate occupied cells
   - validate canPlaceAt results for key placements
   - validate flip computations deterministically

## Output
A single snapshot + test suite that becomes your safety net.
