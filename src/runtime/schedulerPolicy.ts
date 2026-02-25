import type { Agent } from '../engine/schemas'

/**
 * Pick the next round-robin index while avoiding repeating the last speaker when possible.
 */
export function pickRoundRobinIndexAvoidRepeat(
  agents: Agent[],
  preferredIndex: number,
  lastTurnAgentId: string | null
): number {
  if (agents.length <= 1 || lastTurnAgentId == null) return preferredIndex % agents.length
  const normalized = preferredIndex % agents.length
  if (agents[normalized]?.id !== lastTurnAgentId) return normalized
  for (let step = 1; step < agents.length; step++) {
    const idx = (normalized + step) % agents.length
    if (agents[idx]?.id !== lastTurnAgentId) return idx
  }
  return normalized
}

