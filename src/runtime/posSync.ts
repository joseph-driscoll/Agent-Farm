// src/runtime/posSync.ts
import type { WorldState } from '../engine/schemas.js'
import { BACK_WALL_ROWS } from '../engine/worldState.js'

type AgentPos = { x: number; y: number; atMs: number }
const lastPosByAgent = new Map<string, AgentPos>()

export function noteAgentPos(agentId: string, x: number, y: number): void {
  lastPosByAgent.set(agentId, { x, y, atMs: Date.now() })
}

export function applyEphemeralAgentPositions(world: WorldState, maxAgeMs: number = 5_000): WorldState {
  const now = Date.now()
  // Drop stale/unknown entries so the cache does not grow forever across long sessions.
  const liveAgentIds = new Set(world.agents.map((a) => a.id))
  for (const [agentId, pos] of lastPosByAgent) {
    if (!liveAgentIds.has(agentId) || now - pos.atMs > maxAgeMs) lastPosByAgent.delete(agentId)
  }
  const nextAgents = world.agents.map((a) => {
    const p = lastPosByAgent.get(a.id)
    if (!p) return a
    if (now - p.atMs > maxAgeMs) return a
    const py = Math.floor(p.y)
    // Do not keep agents visually parked on back-wall rows after refresh.
    // Exception: Builder may stand on back-wall access row y=2.
    const allowBackWallPose =
      a.role === 'Builder' &&
      py === BACK_WALL_ROWS - 1
    if (py < BACK_WALL_ROWS && !allowBackWallPose) return a
    // Store as cell-center (0.5) coords to match your engine conventions
    const cx = Math.floor(p.x) + 0.5
    const cy = Math.floor(p.y) + 0.5
    return { ...a, x: cx, y: cy }
  })
  return { ...world, agents: nextAgents }
}
