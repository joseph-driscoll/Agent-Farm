/**
 * Client movement: intent → target cell. Used only by the UI.
 * Server does not run movement; reducer still applies MOVE_AGENT for replay.
 *
 * Movement / walkability: the engine and nav grid make chair cells WALKABLE (agents can
 * stand and sit on them). Workstations and most other furniture block movement. Do not
 * assume "chair cells block movement" — that mismatch causes wrong fixes (e.g. making
 * chairs block in nav, which would break sitting).
 */

import type { WorldState } from '../engine/schemas.js'
import type { NavGrid } from '../engine/navGrid.js'
import { BACK_WALL_ROWS } from '../engine/worldState.js'
import { snapToWalkable } from '../engine/navGrid.js'

export { getNextCellToward } from '../engine/navGrid.js'

const MARGIN = 1.5
const FLOOR_MIN_Y = BACK_WALL_ROWS + MARGIN

function chairCells(world: WorldState): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (const item of world.items) {
    if (item.defId !== 'chair') continue
    out.push({ x: item.x, y: item.y })
  }
  return out
}

function isChairCell(world: WorldState, x: number, y: number): boolean {
  return world.items.some((item) => item.defId === 'chair' && item.x === x && item.y === y)
}

/** All walkable cells in the floor area (for hold/explore). Use integer indices for nav.walkable. Includes bottom row (display row 0) so agents can step out of chairs south into that row. */
function walkableCells(nav: NavGrid): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  const minY = Math.floor(FLOOR_MIN_Y)
  const minX = Math.floor(MARGIN)
  const maxY = nav.height - 1
  const maxX = nav.width - Math.ceil(MARGIN)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      if (nav.walkable[y]![x]) out.push({ x, y })
    }
  }
  return out
}

/** Target changes every TARGET_HOLD_MS so agents walk to a goal then get a new one. */
const TARGET_HOLD_MS = 3000

type Cell = { x: number; y: number }
const STEP_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

interface ExplorationState {
  visited: Set<string>
  visitedOrder: Map<string, number>
  blocked: Set<string>
  worldSig: string
  phase: 'explore' | 'circle_back'
  currentTarget: Cell | null
  lastCell: Cell | null
  prevCell: Cell | null
}

const explorationByAgent = new Map<string, ExplorationState>()
let visitCounter = 0

const SIT_MIN_MS = 8_000
const SIT_MAX_MS = 24_000
/** When Nova is doing Tavily research at the computer, keep them seated until the server marks research complete (intent → sit_in_chair). Use a long fallback so we never get up before the server finishes. */
const RESEARCH_SIT_DURATION_MS = 120_000
const SIT_TRIGGER_INTENTS = new Set(['sit_in_chair', 'sit'])
const IDLE_MIN_MS = 700
const IDLE_MAX_MS = 2200
const IDLE_TRIGGER_PERCENT = 35
// All movement intents get the same idle/pause behavior so no agent (e.g. Builder with place_item) is the only one moving.
const IDLE_ELIGIBLE_INTENTS = new Set(['hold', 'research', 'propose', 'place_item', 'expand_room'])

interface SitState {
  chairKey: string
  releaseAtMs: number
}

const sitStateByAgent = new Map<string, SitState>()
const lastChairKeyByAgent = new Map<string, string>()
const idleReleaseByAgent = new Map<string, number>()
const idleBucketByAgent = new Map<string, number>()

export function pruneSteeringCaches(liveAgentIds: Iterable<string>): void {
  const live = new Set(liveAgentIds)
  const pruneMap = <T>(m: Map<string, T>) => {
    for (const id of m.keys()) {
      if (!live.has(id)) m.delete(id)
    }
  }
  pruneMap(explorationByAgent)
  pruneMap(sitStateByAgent)
  pruneMap(lastChairKeyByAgent)
  pruneMap(idleReleaseByAgent)
  pruneMap(idleBucketByAgent)
}

function randomSitDurationMs(): number {
  return Math.floor(SIT_MIN_MS + Math.random() * (SIT_MAX_MS - SIT_MIN_MS))
}

function keyOf(cell: Cell): string {
  return `${cell.x},${cell.y}`
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y
}

function worldSignature(nav: NavGrid): string {
  return `${nav.width}x${nav.height}`
}

function stableHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function getIdleDurationMultiplier(agentId: string, normalizedIntent: string, timeBucket: number): number {
  const roll = stableHash(`idle-mult:${agentId}:${normalizedIntent}:${timeBucket}`) % 100
  if (roll < 15) return 3
  if (roll < 45) return 2
  return 1
}

function getReachableCellKeys(nav: NavGrid, start: Cell): Set<string> {
  const out = new Set<string>()
  if (!nav.walkable[start.y]?.[start.x]) return out
  const queue: Cell[] = [start]
  out.add(keyOf(start))
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!
    for (const [dx, dy] of STEP_DIRS) {
      const nx = cur.x + dx
      const ny = cur.y + dy
      if (nx < 0 || ny < 0 || nx >= nav.width || ny >= nav.height) continue
      if (!nav.walkable[ny]?.[nx]) continue
      const k = `${nx},${ny}`
      if (out.has(k)) continue
      out.add(k)
      queue.push({ x: nx, y: ny })
    }
  }
  return out
}

function nearestByDistance(from: Cell, candidates: Cell[]): Cell | null {
  if (candidates.length === 0) return null
  let best: { cell: Cell; score: number } | null = null
  for (const c of candidates) {
    const score = (from.x - c.x) ** 2 + (from.y - c.y) ** 2
    if (!best || score < best.score) best = { cell: c, score }
  }
  return best?.cell ?? null
}

function isAgentCellOccupied(world: WorldState, agentId: string, x: number, y: number): boolean {
  return world.agents.some((a) => a.id !== agentId && Math.floor(a.x) === x && Math.floor(a.y) === y)
}

/** Cell keys that are currently the target of another agent (so only one agent paths to a given chair). */
function getCellsTargetedByOtherAgents(excludeAgentId: string): Set<string> {
  const out = new Set<string>()
  for (const [otherId, state] of explorationByAgent) {
    if (otherId === excludeAgentId) continue
    if (state.currentTarget) out.add(keyOf(state.currentTarget))
  }
  return out
}

function getOrCreateExplorationState(agentId: string, nav: NavGrid): ExplorationState {
  const sig = worldSignature(nav)
  const existing = explorationByAgent.get(agentId)
  if (!existing) {
    const created: ExplorationState = {
      visited: new Set<string>(),
      visitedOrder: new Map<string, number>(),
      blocked: new Set<string>(),
      worldSig: sig,
      phase: 'explore',
      currentTarget: null,
      lastCell: null,
      prevCell: null,
    }
    explorationByAgent.set(agentId, created)
    return created
  }
  if (existing.worldSig !== sig) {
    existing.worldSig = sig
    existing.phase = 'explore'
    existing.visited.clear()
    existing.visitedOrder.clear()
    existing.blocked.clear()
    existing.currentTarget = null
    existing.lastCell = null
    existing.prevCell = null
  }
  return existing
}

function markVisited(state: ExplorationState, cell: Cell): void {
  const k = keyOf(cell)
  if (!state.visited.has(k)) state.visited.add(k)
  state.visitedOrder.set(k, ++visitCounter)
}

export function noteBlockedCellForAgent(agentId: string, cell: Cell): void {
  const state = explorationByAgent.get(agentId)
  if (!state) return
  const key = keyOf(cell)
  state.blocked.add(key)
  if (state.currentTarget && keyOf(state.currentTarget) === key) state.currentTarget = null
}

function pickExplorationTarget(
  world: WorldState,
  agentId: string,
  curCell: Cell,
  allWalkable: Cell[],
  state: ExplorationState
): Cell | null {
  markVisited(state, curCell)
  if (!sameCell(state.lastCell, curCell)) {
    state.prevCell = state.lastCell
    state.lastCell = curCell
  }

  // Keep memory in sync with current walkable map so stale walls/obstacles do not pollute decisions.
  const walkableSet = new Set(allWalkable.map((c) => keyOf(c)))
  for (const k of [...state.visited]) if (!walkableSet.has(k)) state.visited.delete(k)
  for (const k of [...state.blocked]) if (!walkableSet.has(k)) state.blocked.delete(k)
  for (const k of [...state.visitedOrder.keys()]) if (!walkableSet.has(k)) state.visitedOrder.delete(k)
  if (state.currentTarget && !walkableSet.has(keyOf(state.currentTarget))) state.currentTarget = null

  const unoccupied = allWalkable.filter((c) => !isAgentCellOccupied(world, agentId, c.x, c.y))
  const unblocked = unoccupied.filter((c) => !state.blocked.has(keyOf(c)))
  const unexplored = unblocked.filter((c) => !state.visited.has(keyOf(c)))

  if (state.currentTarget) {
    const targetKey = keyOf(state.currentTarget)
    const reached = sameCell(state.currentTarget, curCell)
    const blocked = state.blocked.has(targetKey)
    const occupied = isAgentCellOccupied(world, agentId, state.currentTarget.x, state.currentTarget.y)
    if (!reached && !blocked && !occupied && walkableSet.has(targetKey)) return state.currentTarget
    state.currentTarget = null
  }

  if (unexplored.length > 0) state.phase = 'explore'
  else state.phase = 'circle_back'

  const candidates = state.phase === 'explore'
    ? unexplored
    : (unblocked.length > 0 ? unblocked : unoccupied)
  if (candidates.length === 0) return null

  // Tie-breaker: deterministic by (x, y) so all agents prefer the same neighbor when distance ties (no role-based bias).
  const cellTie = (c: Cell) => (c.x * 1000 + c.y) * 1e-6

  if (state.phase === 'explore') {
    let best: { cell: Cell; score: number } | null = null
    for (const c of candidates) {
      const dist = Math.abs(c.x - curCell.x) + Math.abs(c.y - curCell.y)
      const backtrackPenalty = state.prevCell && c.x === state.prevCell.x && c.y === state.prevCell.y ? 0.75 : 0
      const score = dist + backtrackPenalty + cellTie(c)
      if (!best || score < best.score) best = { cell: c, score }
    }
    state.currentTarget = best?.cell ?? null
    return state.currentTarget
  }

  let best: { cell: Cell; score: number } | null = null
  for (const c of candidates) {
    const k = keyOf(c)
    const seenOrder = state.visitedOrder.get(k) ?? -1
    const dist = Math.abs(c.x - curCell.x) + Math.abs(c.y - curCell.y)
    const backtrackPenalty = state.prevCell && c.x === state.prevCell.x && c.y === state.prevCell.y ? 0.75 : 0
    const score = seenOrder + dist * 0.01 + backtrackPenalty + cellTie(c)
    if (!best || score < best.score) best = { cell: c, score }
  }
  state.currentTarget = best?.cell ?? null
  return state.currentTarget
}

/**
 * Single source of truth: given agent and intent, return target cell (integer).
 * World.agents[].x/y should be client positions when used from the view.
 */
export function getTargetCellForIntent(
  world: WorldState,
  agentId: string,
  intent: string,
  nav: NavGrid
): { x: number; y: number } | null {
  const agent = world.agents.find((a) => a.id === agentId)
  if (!agent) return null
  const w = world.gridWidth
  const h = world.gridHeight
  const timeBucket = Math.floor(performance.now() / TARGET_HOLD_MS)
  const cells = walkableCells(nav)
  const curCell = { x: Math.floor(agent.x), y: Math.floor(agent.y) }
  const onChairNow = isChairCell(world, curCell.x, curCell.y)
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const normalizedIntent = intent.toLowerCase()
  const idleEligible = IDLE_ELIGIBLE_INTENTS.has(normalizedIntent)
  const chairKey = `${curCell.x},${curCell.y}`

  // Reset seat timer and chair target when the agent leaves a chair.
  if (!onChairNow && sitStateByAgent.has(agentId)) {
    sitStateByAgent.delete(agentId)
  }
  if (!onChairNow) lastChairKeyByAgent.delete(agentId)
  const reachableKeys = getReachableCellKeys(nav, curCell)
  const reachableCells = cells.filter((c) => reachableKeys.has(keyOf(c)))
  const explorationState = getOrCreateExplorationState(agentId, nav)
  // Do NOT clear chair currentTarget when !onChairNow — that caused Pixel/Sage to re-pick chair every frame and vibrate. Stick to the same chair until we reach it.
  // Use agentId hash so no agent has a fixed offset by array order (idx made Worker always get a biased far target).
  const dynamicSeed = timeBucket * 7 + (stableHash(agentId) % 1000)

  const pickWithSeed = (arr: Array<{ x: number; y: number }>, seed: number): { x: number; y: number } | null =>
    arr.length === 0 ? null : arr[Math.abs(seed) % arr.length]!

  // Fallback target: only pick from cells within this distance so no agent gets a "long direction" cross-grid target.
  const MAX_FALLBACK_DIST = 4
  const nearbyReachable = reachableCells.filter(
    (c) => Math.abs(c.x - curCell.x) + Math.abs(c.y - curCell.y) <= MAX_FALLBACK_DIST
  )
  const fallbackPool = nearbyReachable.length > 0 ? nearbyReachable : reachableCells

  // Timed seating: only explicit sit intents trigger it.
  if (onChairNow) {
    const current = sitStateByAgent.get(agentId)
    if (current && current.chairKey === chairKey && nowMs < current.releaseAtMs) {
      lastChairKeyByAgent.set(agentId, chairKey)
      return curCell
    }
    const lastChairKey = lastChairKeyByAgent.get(agentId)
    const enteredNewChair = lastChairKey !== chairKey
    // When an agent newly sits down on any chair tile, hold there for a while.
    if (!current && enteredNewChair) {
      sitStateByAgent.set(agentId, { chairKey, releaseAtMs: nowMs + randomSitDurationMs() })
      lastChairKeyByAgent.set(agentId, chairKey)
      explorationState.currentTarget = null // clear so when we get up we don't immediately path back to same chair
      return curCell
    }
    if (SIT_TRIGGER_INTENTS.has(normalizedIntent)) {
      sitStateByAgent.set(agentId, {
        chairKey,
        releaseAtMs: nowMs + randomSitDurationMs(),
      })
      lastChairKeyByAgent.set(agentId, chairKey)
      return curCell
    }
    if (normalizedIntent === 'research') {
      sitStateByAgent.set(agentId, {
        chairKey,
        releaseAtMs: nowMs + RESEARCH_SIT_DURATION_MS,
      })
      lastChairKeyByAgent.set(agentId, chairKey)
      return curCell
    }
    if (current && nowMs >= current.releaseAtMs) {
      sitStateByAgent.delete(agentId)
    }
    lastChairKeyByAgent.set(agentId, chairKey)
  }

  // Human-like movement: short random pauses so agents do not move continuously.
  // Skip idle for the first time bucket so no agent is deterministically "the only one moving" at tick 0
  // (stableHash(agentId) made e.g. Builder always get seeded >= 35 and others < 35).
  if (!idleEligible) {
    idleReleaseByAgent.delete(agentId)
  } else if (!onChairNow && timeBucket > 0) {
    const currentIdleRelease = idleReleaseByAgent.get(agentId)
    if (currentIdleRelease != null && nowMs < currentIdleRelease) {
      return curCell
    }
    if (currentIdleRelease != null && nowMs >= currentIdleRelease) {
      idleReleaseByAgent.delete(agentId)
    }
    const seeded = stableHash(`idle:${agentId}:${normalizedIntent}:${timeBucket}`) % 100
    const alreadyIdledThisBucket = idleBucketByAgent.get(agentId) === timeBucket
    if (!alreadyIdledThisBucket && seeded < IDLE_TRIGGER_PERCENT) {
      const durationSpan = IDLE_MAX_MS - IDLE_MIN_MS + 1
      const durationSeed = stableHash(`idle-duration:${agentId}:${normalizedIntent}:${timeBucket}`)
      const baseIdleDurationMs = IDLE_MIN_MS + (durationSeed % durationSpan)
      const idleDurationMs = baseIdleDurationMs * getIdleDurationMultiplier(agentId, normalizedIntent, timeBucket)
      idleReleaseByAgent.set(agentId, nowMs + idleDurationMs)
      idleBucketByAgent.set(agentId, timeBucket)
      return curCell
    }
  }

  let pt: { x: number; y: number } | null = null
  switch (intent) {
    case 'sit_in_chair':
    case 'sit':
    case 'research': {
      const chairs = chairCells(world)
        .filter((c) => nav.walkable[c.y]?.[c.x])
        .filter((c) => reachableKeys.has(keyOf(c)))
      const targetedByOthers = getCellsTargetedByOtherAgents(agentId)
      // Only one agent per chair: exclude occupied cells and chairs another agent is pathing to.
      const candidates = chairs.filter((c) => {
        const inThisChair = c.x === curCell.x && c.y === curCell.y
        if (inThisChair) return true
        if (isAgentCellOccupied(world, agentId, c.x, c.y)) return false
        if (targetedByOthers.has(keyOf(c))) return false
        return true
      })
      if (candidates.length > 0) {
        // Stick to the same chair we were pathing to (avoids Pixel/Sage swapping targets and vibrating).
        const existingChair = explorationState.currentTarget && isChairCell(world, explorationState.currentTarget.x, explorationState.currentTarget.y)
        const existingInCandidates = existingChair && candidates.some((c) => c.x === explorationState.currentTarget!.x && c.y === explorationState.currentTarget!.y)
        if (existingInCandidates) {
          pt = explorationState.currentTarget
        } else {
          let best: { cell: Cell; score: number } | null = null
          for (const c of candidates) {
            const dist = Math.abs(c.x - curCell.x) + Math.abs(c.y - curCell.y)
            const alreadySittingBonus = isChairCell(world, curCell.x, curCell.y) && c.x === curCell.x && c.y === curCell.y ? -1 : 0
            const tie = stableHash(`sit:${agentId}:${c.x},${c.y}`) * 1e-6
            const score = dist + alreadySittingBonus + tie
            if (!best || score < best.score) best = { cell: c, score }
          }
          pt = best?.cell ?? null
          if (pt) explorationState.currentTarget = pt
        }
      } else {
        pt = pickExplorationTarget(world, agentId, curCell, reachableCells, explorationState) ??
          (fallbackPool.length > 0 ? pickWithSeed(fallbackPool, dynamicSeed) : { x: Math.floor(w / 2), y: Math.floor(FLOOR_MIN_Y) + 2 })
      }
      break
    }
    case 'place_item':
      // Worker stays put while placing — no wandering; only move when server sends MOVE_AGENT (e.g. off placement spot).
      pt = curCell
      break
    case 'propose':
    case 'hold':
    default:
      pt = pickExplorationTarget(world, agentId, curCell, reachableCells, explorationState) ??
        (fallbackPool.length > 0 ? pickWithSeed(fallbackPool, dynamicSeed) : { x: Math.floor(w / 2), y: Math.floor(FLOOR_MIN_Y) + 2 })
  }
  if (!pt) return null
  const clamped = {
    x: Math.max(0, Math.min(w - 1, pt.x)),
    y: Math.max(BACK_WALL_ROWS, Math.min(h - 1, pt.y)),
  }
  const snapped = snapToWalkable(nav, clamped.x, clamped.y)
  if (!snapped) return null
  const final = reachableKeys.has(keyOf(snapped)) ? snapped : nearestByDistance(snapped, reachableCells)
  if ((normalizedIntent === 'sit_in_chair' || normalizedIntent === 'sit') && final && isChairCell(world, final.x, final.y)) {
    explorationState.currentTarget = final
  }
  if (reachableKeys.has(keyOf(snapped))) return snapped
  return nearestByDistance(snapped, reachableCells)
}
