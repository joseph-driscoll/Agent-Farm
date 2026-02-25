/**
 * Scoring heuristics: power, aesthetic, collaboration, waste.
 * Used to compute totals and to guide Judge/Architect.
 */

import type { WorldState } from './schemas.js'
import { getItemDef } from './worldState.js'

export function computePowerScore(world: WorldState): number {
  let power = 0
  for (const item of world.items) {
    const def = getItemDef(world, item.defId)
    if (def) power += def.powerValue
  }
  power += world.artifacts.length * 0.5
  power += world.unlockedTech.length * 2
  return power
}

export function computeAestheticScore(world: WorldState): number {
  let aesthetic = 0
  for (const item of world.items) {
    const def = getItemDef(world, item.defId)
    if (def) aesthetic += def.aestheticValue
  }
  const floorCells = world.cells.filter((c) => c.kind === 'floor').length
  const density = world.items.length / Math.max(1, floorCells)
  if (density >= 0.05 && density <= 0.3) aesthetic += 2
  if (world.items.length >= 2) aesthetic += 1
  return aesthetic
}

export function computeCollaborationScore(world: WorldState): number {
  return world.artifacts.length * 1.5
}

export function totalScore(world: WorldState): number {
  const power = computePowerScore(world)
  const aesthetic = computeAestheticScore(world)
  const collaboration = computeCollaborationScore(world)
  const waste = world.scores.wastePenalty
  return power + aesthetic + collaboration - waste
}

export function updateScoresFromWorld(world: WorldState): WorldState {
  return {
    ...world,
    scores: {
      power: computePowerScore(world),
      aesthetic: computeAestheticScore(world),
      collaboration: computeCollaborationScore(world),
      wastePenalty: world.scores.wastePenalty,
    },
  }
}
