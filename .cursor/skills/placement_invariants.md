# Skill: Placement Invariants

## Invariants to enforce
- Border ring is blocked.
- Workstations stack only in permitted rows/columns.
- Aisle cells remain empty.
- Chair adjacency rules are exact and engine-owned.
- Computer placement is engine-owned and stored in state; renderer only draws.

## Checklist
- canPlaceAt enforces it
- canFitAt mirrors it
- tests cover it
