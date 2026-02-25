# PR Gate (Must Pass)

## Architecture
- [ ] No gameplay/legality logic added to UI
- [ ] Determinism preserved (no Date.now/random in reducer/engine)
- [ ] Runtime mirror updated if engine legality changed

## Tests
- [ ] Behavior change has tests
- [ ] At least 2 cases for each new rule (allow + block)
- [ ] Regression test added if bugfix

## Documentation
- [ ] Updated changelog note in modified engine file if rule change
- [ ] Diff narrative included in PR description

## Placement/Render bugs only
- [ ] Truth Table included
- [ ] Renderer does not rewrite grid cells
