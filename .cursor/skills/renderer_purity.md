# Skill: Renderer Purity

## Goal
Ensure rendering is a pure function of state.

## Checks
- Renderer must not adjust `x,y` based on other items to "fix" placement.
- Renderer may:
  - set anchors
  - apply pixel nudges
  - adjust z-order/layer containers
- Renderer must not:
  - translate item coordinates into other cells
  - implement adjacency logic that affects where something "should be"

## If a render problem seems to require snapping cells
That is a state problem. Fix engine placement choice, or store a derived placement decision in state at placement time.
