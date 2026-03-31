/**
 * Runtime: tick loop, persistence, HTTP server.
 * Autonomous loop: LLM-driven agents that move, talk, research (Tavily), and build.
 *
 * FIXES:
 * - No async tick overlap (major jank fix)
 * - Stable movement loop
 * - Clean shutdown
 */

import http from 'http'
import { WebSocketServer } from 'ws'
import {
  openDb,
  closeDb,
  loadWorldState,
  appendEvent,
  clearAllEvents,
} from '../src/runtime/persistence.js'

import {
  reduce,
  advanceTick,
  getFirstUnexecutedProposal,
  getUnexecutedProposalCount,
} from '../src/engine/reducer.js'

import { updateScoresFromWorld } from '../src/engine/scoring.js'
import {
  createInitialWorldState,
  getDeskSlotsInOrder,
  getSlotCompletion,
  shuffleSlotsForAssignment,
  normalizeDefId,
  getItemDef,
  getWorkstationCells,
  isCellBlockedForAgents,
  isInBounds,
  getValidPlacementTiles,
  ensureAgentsNotOnBlockedCells,
  BACK_WALL_ROWS,
  isStructuralWallPiece,
} from '../src/engine/worldState.js'
import type { WorldState, Action } from '../src/engine/schemas.js'

import {
  getAgentTurn,
  buildWorldSnapshot,
  getRealitySummary,
  getConversationPhase,
  formatAgentMemory,
  filterBannedPhrases,
  truncateSay,
  type SnapshotWorld,
} from '../src/runtime/llm.js'
import { applyEphemeralAgentPositions, noteAgentPos } from '../src/runtime/posSync.js'
import { getModelForRole, getPersonalityForRole } from '../src/runtime/agentRoles.js'
import { research as runTavilyResearch, extract as runTavilyExtract, crawl as runTavilyCrawl } from '../src/runtime/tavily.js'
import {
  hasPixellab,
  createCharacter as runPixellabCreateCharacter,
  animateCharacter as runPixellabAnimateCharacter,
  createTileset as runPixellabCreateTileset,
  createIsometricTile as runPixellabCreateIsometricTile,
} from '../src/runtime/pixellab.js'
import { log, getLogDump, clearLogBuffer } from '../src/logger.js'
import { pickRoundRobinIndexAvoidRepeat } from '../src/runtime/schedulerPolicy.js'

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

/* -------------------------------------------------------------------------- */
/* ENV                                                                        */
/* -------------------------------------------------------------------------- */

function loadEnvFile(envPath: string): boolean {
  if (!existsSync(envPath)) return false
  try {
    const env = readFileSync(envPath, 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
      }
    }
    return true
  } catch {
    return false
  }
}

function loadEnv(): void {
  const cwdPath = resolve(process.cwd(), '.env')
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const rootPath = resolve(projectRoot, '.env')
  loadEnvFile(cwdPath) || loadEnvFile(rootPath)
}
loadEnv()

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.RUNTIME_PORT) || 3011
/** Sim/broadcast: step often so client can interpolate. Never blocked by LLM. */
const SIM_BROADCAST_MS = Number(process.env.SIM_BROADCAST_MS) || 200
const FORCE_BROADCAST_MS = Number(process.env.FORCE_BROADCAST_MS) || 1500
const LLM_TURN_TIMEOUT_MS = Number(process.env.LLM_TURN_TIMEOUT_MS) || 120_000
const LOOP_STALL_WARN_MS = Number(process.env.LOOP_STALL_WARN_MS) || 180_000
const MIN_AGENT_TURN_GAP_MS = Number(process.env.MIN_AGENT_TURN_GAP_MS) || 900
/** Minimum ms between starting one LLM request and the next (avoids 429 on free-tier providers). */
const MIN_LLM_REQUEST_GAP_MS = Number(process.env.MIN_LLM_REQUEST_GAP_MS) || 1500
const RETRYABLE_TURN_BACKOFF_MS = Number(process.env.RETRYABLE_TURN_BACKOFF_MS) || 2500
const AGENT_RETRY_COOLDOWN_MS = Number(process.env.AGENT_RETRY_COOLDOWN_MS) || 60_000
const MEMORY_MONITOR_MS = Number(process.env.MEMORY_MONITOR_MS) || 30_000
const MEMORY_MONITOR_WINDOW = Math.max(3, Number(process.env.MEMORY_MONITOR_WINDOW) || 8)
const MEMORY_MONITOR_WARN_SLOPE_MB_PER_MIN =
  Number(process.env.MEMORY_MONITOR_WARN_SLOPE_MB_PER_MIN) || 12
const MEMORY_MONITOR_WARN_COOLDOWN_MS = Number(process.env.MEMORY_MONITOR_WARN_COOLDOWN_MS) || 5 * 60_000
/** Ticks of conversation-only warmup before proposals/voting/placing. 0 = agents can propose and place from tick 0. */
const WARMUP_TICKS = 0
/** When true, Builder places from queue without an LLM call (saves one API call per placement). */
const SKIP_LLM_FOR_BUILDER_PLACEMENT = process.env.SKIP_LLM_FOR_BUILDER_PLACEMENT !== 'false'
/** When true, Architect adds a proposal from valid spots without an LLM call when queue has room (saves API calls). */
const SKIP_LLM_FOR_ARCHITECT_PROPOSAL = process.env.SKIP_LLM_FOR_ARCHITECT_PROPOSAL !== 'false'

/* -------------------------------------------------------------------------- */
/* STATE                                                                      */
/* -------------------------------------------------------------------------- */

let worldState: WorldState = createInitialWorldState()
let eventIndexThisTick = 0
let broadcastCount = 0
let worldDirtyForBroadcast = true
let lastBroadcastAtMs = 0

/** When false, no LLM calls — stub turns only (for frontend debugging without using credits). */
let llmEnabled = true

let llmInFlight = false
let llmInFlightStartedAt = 0
let lastTurnCompletedAt = Date.now()
/** Timestamp when we last started an LLM API request (used to enforce MIN_LLM_REQUEST_GAP_MS). */
let lastLlmRequestAt = 0
let turnScheduleTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveRetryableTurnErrors = 0
let nextAgentTurnIndex = 0
let builderPriorityStreak = 0
/** After a retryable API error (402, 429), skip "researcher first report" for one round so Builder/Architect can run and the chain does not stall on Nova. */
let skipResearcherFirstReportNextTurn = false
/** Prevent "first report due" from starving Architect/Builder forever if Researcher keeps returning hold. */
const RESEARCHER_FIRST_REPORT_STREAK_MAX = 2
let researcherFirstReportStreak = 0
/** When queue is empty we prefer Architect so they add a proposal before Builder tries to place. Capped to avoid infinite Architect turns if they never output createArtifact. Kept low (2) to reduce hold frequency — interleave others sooner. */
const ARCHITECT_EMPTY_QUEUE_STREAK_MAX = 2
let architectEmptyQueueStreak = 0
/** Tick at which we last added a proposal (CREATE_ARTIFACT Proposal). Used to ensure a proposal is made at least every 3 ticks when queue has room. */
let lastProposalAddedTick = 0
const TICKS_BETWEEN_PROPOSALS = 3
/** Consecutive Builder or Architect turns; after this many we force a round-robin turn so Researcher (Nova) gets to speak. Lower value (2) reduces hold-heavy streaks. */
const PRIORITY_STREAK_BEFORE_ROUND_ROBIN = 2
let priorityStreak = 0
/** Last agent who took a turn — avoid scheduling the same agent twice in a row for dialogue (smoother interchange). */
let lastTurnAgentId: string | null = null
let stopLoops = false
let wss: WebSocketServer
/** True while a Tavily research/extract/crawl is running in the background — prevents Nova from starting another until the report is done. */
let researcherTavilyInFlight = false
/** True while a PixelLab request is in flight — one at a time to avoid rate limits. */
let pixellabInFlight = false
const retryBlockedUntilByAgent = new Map<string, number>()
let lastMemoryWarnAtMs = 0
const memorySamples: Array<{ atMs: number; heapUsedMb: number; rssMb: number }> = []

function getRuntimeStats(): Record<string, unknown> {
  const mem = process.memoryUsage()
  const rssMb = Number((mem.rss / (1024 * 1024)).toFixed(2))
  const heapUsedMb = Number((mem.heapUsed / (1024 * 1024)).toFixed(2))
  const heapTotalMb = Number((mem.heapTotal / (1024 * 1024)).toFixed(2))
  return {
    uptimeSec: Math.floor(process.uptime()),
    memory: {
      rssMb,
      heapUsedMb,
      heapTotalMb,
      externalMb: Number((mem.external / (1024 * 1024)).toFixed(2)),
      arrayBuffersMb: Number((((mem as { arrayBuffers?: number }).arrayBuffers ?? 0) / (1024 * 1024)).toFixed(2)),
    },
    world: {
      tick: worldState.tick,
      gridWidth: worldState.gridWidth,
      gridHeight: worldState.gridHeight,
      items: worldState.items.length,
      artifacts: worldState.artifacts.length,
      chatLog: (worldState.chatLog ?? []).length,
      lastEvents: (worldState.lastEvents ?? []).length,
    },
    scheduler: {
      llmInFlight,
      researcherTavilyInFlight,
      consecutiveRetryableTurnErrors,
      nextAgentTurnIndex,
      builderPriorityStreak,
      priorityStreak,
    },
    ws: {
      clients: wss?.clients?.size ?? 0,
    },
  }
}

function recordMemorySampleAndMaybeWarn(): void {
  const now = Date.now()
  const mem = process.memoryUsage()
  const sample = {
    atMs: now,
    heapUsedMb: mem.heapUsed / (1024 * 1024),
    rssMb: mem.rss / (1024 * 1024),
  }
  memorySamples.push(sample)
  if (memorySamples.length > MEMORY_MONITOR_WINDOW) {
    memorySamples.splice(0, memorySamples.length - MEMORY_MONITOR_WINDOW)
  }
  if (memorySamples.length < 2) return

  const first = memorySamples[0]!
  const last = memorySamples[memorySamples.length - 1]!
  const minutes = (last.atMs - first.atMs) / 60_000
  if (minutes <= 0) return
  const heapSlopeMbPerMin = (last.heapUsedMb - first.heapUsedMb) / minutes
  const rssSlopeMbPerMin = (last.rssMb - first.rssMb) / minutes
  const overThreshold =
    heapSlopeMbPerMin >= MEMORY_MONITOR_WARN_SLOPE_MB_PER_MIN ||
    rssSlopeMbPerMin >= MEMORY_MONITOR_WARN_SLOPE_MB_PER_MIN
  const cooledDown = now - lastMemoryWarnAtMs >= MEMORY_MONITOR_WARN_COOLDOWN_MS
  if (!overThreshold || !cooledDown) return

  lastMemoryWarnAtMs = now
  log('WARN', 'memory growth trend detected', {
    heapSlopeMbPerMin: Number(heapSlopeMbPerMin.toFixed(2)),
    rssSlopeMbPerMin: Number(rssSlopeMbPerMin.toFixed(2)),
    thresholdMbPerMin: MEMORY_MONITOR_WARN_SLOPE_MB_PER_MIN,
    samples: memorySamples.length,
    windowMinutes: Number(minutes.toFixed(2)),
    heapUsedMb: Number(last.heapUsedMb.toFixed(2)),
    rssMb: Number(last.rssMb.toFixed(2)),
    worldTick: worldState.tick,
  })
}

function markTurnCompleted(): void {
  lastTurnCompletedAt = Date.now()
  llmInFlightStartedAt = 0
}

function scheduleNextAgentTurn(delayMs: number): void {
  if (stopLoops) return
  if (turnScheduleTimer) clearTimeout(turnScheduleTimer)
  turnScheduleTimer = setTimeout(() => {
    turnScheduleTimer = null
    tryStartAgentTurn()
  }, Math.max(0, Math.floor(delayMs)))
}

function isAgentRetryBlocked(agentId: string, nowMs: number): boolean {
  const until = retryBlockedUntilByAgent.get(agentId) ?? 0
  if (until <= 0) return false
  if (nowMs >= until) {
    retryBlockedUntilByAgent.delete(agentId)
    return false
  }
  return true
}

function pickRoundRobinAgentAvoidBlocked(
  agents: WorldState['agents'],
  startIndex: number,
  nowMs: number
): { agent: WorldState['agents'][0]; index: number } {
  const len = agents.length
  for (let i = 0; i < len; i++) {
    const idx = (startIndex + i) % len
    const candidate = agents[idx]!
    if (!isAgentRetryBlocked(candidate.id, nowMs)) return { agent: candidate, index: idx }
  }
  const idx = ((startIndex % len) + len) % len
  return { agent: agents[idx]!, index: idx }
}

/* -------------------------------------------------------------------------- */
/* LOAD                                                                       */
/* -------------------------------------------------------------------------- */

function loadState(): void {
  try {
    openDb()
    worldState = loadWorldState()
    if (worldState.agents.length === 0) {
      worldState = createInitialWorldState()
      worldState = ensureAgentsNotOnBlockedCells(worldState)
      log('STATE', 'loaded empty, using initial world (agents on unoccupied floor)')
    } else {
      worldState = ensureAgentsNotOnBlockedCells(worldState)
      log('STATE', 'loaded from persistence', { tick: worldState.tick, agents: worldState.agents.length, items: worldState.items.length })
    }
    worldDirtyForBroadcast = true
    lastProposalAddedTick = worldState.tick
  } catch (e) {
    log('PERSISTENCE', 'load failed, using initial world', { error: String(e) })
    worldState = createInitialWorldState()
    worldState = ensureAgentsNotOnBlockedCells(worldState)
    worldDirtyForBroadcast = true
    lastProposalAddedTick = worldState.tick
  }
}

/* -------------------------------------------------------------------------- */
/* APPLY ACTION                                                               */
/* -------------------------------------------------------------------------- */

function actionSummary(action: Action): Record<string, unknown> {
  const a = action as Action & { agentId?: string; reason?: string; defId?: string; x?: number; y?: number; artifactId?: string; vote?: string; intent?: string; text?: string }
  const base: Record<string, unknown> = { type: action.type, agentId: a.agentId }
  if (a.reason) base.reason = a.reason
  if (a.defId != null) base.defId = a.defId
  if (a.x != null) base.x = a.x
  if (a.y != null) base.y = a.y
  if (a.artifactId) base.artifactId = a.artifactId
  if (a.vote) base.vote = a.vote
  if (a.intent) base.intent = (a.intent as string).slice(0, 60)
  if (a.text) base.textLen = (a.text as string).length
  return base
}

function applyAction(action: Action): boolean {
  const { state: next, event } = reduce(worldState, action, eventIndexThisTick)
  const isFail = event.action.type === 'FAIL_ACTION'
  if (isFail) {
    const fail = event.action as Action & { reason?: string; attemptedAction?: Action }
    log('REDUCER', 'FAIL_ACTION', { ...actionSummary(event.action), reason: fail.reason, attempted: fail.attemptedAction?.type })
  } else if (action.type !== 'MOVE_AGENT') {
    log('REDUCER', 'ok', actionSummary(action))
  }
  worldState = next
  worldDirtyForBroadcast = true
  if (action.type !== 'MOVE_AGENT') {
    // Persist reducer-resolved action so replay matches exactly (including normalized/snap behavior and FAIL_ACTION outcomes).
    appendEvent(worldState.tick, eventIndexThisTick, event.action as Action)
  }
  eventIndexThisTick++
  return !isFail
}

type WalkableStats = { total: number; largestRegion: number }
const INTERIOR_SECTION_MIN_W = 8
const INTERIOR_SECTION_MIN_H = 5

function getPlacementCellsForDef(w: WorldState, defId: string, x: number, y: number): Array<[number, number]> {
  if (defId === 'workstation') return getWorkstationCells(x, y)
  const def = getItemDef(w, defId)
  if (!def) return [[x, y]]
  const [fw, fh] = def.footprint
  const out: Array<[number, number]> = []
  for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) out.push([x + dx, y + dy])
  return out
}

function getWalkableStats(w: WorldState): WalkableStats {
  const seen = new Set<string>()
  const key = (x: number, y: number) => `${x},${y}`
  let total = 0
  let largestRegion = 0
  for (let y = BACK_WALL_ROWS; y < w.gridHeight; y++) {
    for (let x = 0; x < w.gridWidth; x++) {
      if (isCellBlockedForAgents(w, x, y)) continue
      total++
      const k = key(x, y)
      if (seen.has(k)) continue
      let size = 0
      const q: Array<[number, number]> = [[x, y]]
      seen.add(k)
      while (q.length > 0) {
        const [cx, cy] = q.shift()!
        size++
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= w.gridWidth || ny < BACK_WALL_ROWS || ny >= w.gridHeight) continue
          if (isCellBlockedForAgents(w, nx, ny)) continue
          const nk = key(nx, ny)
          if (seen.has(nk)) continue
          seen.add(nk)
          q.push([nx, ny])
        }
      }
      if (size > largestRegion) largestRegion = size
    }
  }
  return { total, largestRegion }
}

function withHypotheticalPlacement(w: WorldState, defId: string, x: number, y: number): WorldState {
  return {
    ...w,
    items: [
      ...w.items,
      {
        id: `candidate-${defId}-${x}-${y}`,
        defId,
        x,
        y,
        placedAtTick: w.tick,
        flipped: false,
      },
    ],
  }
}

function shouldProtectConnectivity(defId: string): boolean {
  if (defId === 'floor' || defId.startsWith('wall_art') || defId === 'post_its') return false
  if (isStructuralWallPiece(defId)) return true
  if (defId.startsWith('wall_')) return false
  return true
}

function countLocalBlockingItems(w: WorldState, x: number, y: number, fw: number, fh: number): number {
  let n = 0
  for (const item of w.items) {
    const def = getItemDef(w, item.defId)
    if (!def) continue
    if (item.defId === 'floor') continue
    const [iw, ih] = def.footprint
    const overlapX = item.x <= x + fw + 1 && item.x + iw - 1 >= x - 1
    const overlapY = item.y <= y + fh + 1 && item.y + ih - 1 >= y - 1
    if (overlapX && overlapY) n++
  }
  return n
}

function minDistanceToWorkstations(w: WorldState, cells: Array<[number, number]>): number {
  const ws = w.items.filter((i) => i.defId === 'workstation')
  if (ws.length === 0) return 99
  let best = 99
  for (const desk of ws) {
    const wsCells = getWorkstationCells(desk.x, desk.y)
    for (const [cx, cy] of cells) {
      for (const [wx, wy] of wsCells) {
        const d = Math.abs(cx - wx) + Math.abs(cy - wy)
        if (d < best) best = d
      }
    }
  }
  return best
}

function isAmenityOrDecor(defId: string): boolean {
  return !['workstation', 'chair', 'computer'].includes(defId) && !isStructuralWallPiece(defId)
}

function hasWallPieceAt(w: WorldState, x: number, y: number): boolean {
  return w.items.some((i) => isStructuralWallPiece(i.defId) && i.x === x && i.y === y)
}

function getWorkstationBounds(w: WorldState): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const desks = w.items.filter((i) => i.defId === 'workstation')
  if (desks.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const d of desks) {
    minX = Math.min(minX, d.x)
    maxX = Math.max(maxX, d.x + 4)
    minY = Math.min(minY, d.y)
    maxY = Math.max(maxY, d.y + 1)
  }
  return { minX, maxX, minY, maxY }
}

function buildInteriorSectionWallTargets(w: WorldState): Array<{ x: number; y: number }> {
  const bounds = getWorkstationBounds(w)
  // Keep at least one-cell clearance from room edges and keep sections under the wall band.
  const minInnerX = 1
  const maxInnerX = Math.max(1, w.gridWidth - 2)
  const minInnerY = BACK_WALL_ROWS + 1
  const maxInnerY = Math.max(minInnerY, w.gridHeight - 2)
  let innerMinX = bounds ? bounds.minX - 1 : Math.max(2, w.gridWidth - INTERIOR_SECTION_MIN_W - 4)
  let innerMaxX = bounds ? bounds.maxX + 1 : Math.min(maxInnerX, innerMinX + INTERIOR_SECTION_MIN_W - 1)
  let innerMinY = bounds ? bounds.minY - 1 : Math.max(BACK_WALL_ROWS + 2, BACK_WALL_ROWS + 4)
  let innerMaxY = bounds ? bounds.maxY + 2 : Math.min(maxInnerY, innerMinY + INTERIOR_SECTION_MIN_H - 1)

  innerMinX = Math.max(minInnerX, innerMinX)
  innerMaxX = Math.min(maxInnerX, innerMaxX)
  innerMinY = Math.max(minInnerY, innerMinY)
  innerMaxY = Math.min(maxInnerY, innerMaxY)

  // Enforce minimum interior section size (>= 8x5 or 5x8; we keep 8x5 as baseline).
  while (innerMaxX - innerMinX + 1 < INTERIOR_SECTION_MIN_W) {
    if (innerMinX > minInnerX) innerMinX--
    else if (innerMaxX < maxInnerX) innerMaxX++
    else break
  }
  while (innerMaxY - innerMinY + 1 < INTERIOR_SECTION_MIN_H) {
    if (innerMaxY < maxInnerY) innerMaxY++
    else if (innerMinY > minInnerY) innerMinY--
    else break
  }

  const left = Math.max(0, innerMinX - 1)
  const right = Math.min(w.gridWidth - 1, innerMaxX + 1)
  const top = Math.max(BACK_WALL_ROWS, innerMinY - 1)
  const bottom = Math.min(w.gridHeight - 1, innerMaxY + 1)
  // Keep a 2-cell doorway on south edge so paths stay clear into the section.
  const doorStart = innerMinX + Math.max(0, Math.floor((innerMaxX - innerMinX - 1) / 2))
  const out: Array<{ x: number; y: number }> = []
  for (let x = left; x <= right; x++) {
    out.push({ x, y: top })
    if (!(x >= doorStart && x <= doorStart + 1)) out.push({ x, y: bottom })
  }
  for (let y = top + 1; y <= bottom - 1; y++) {
    out.push({ x: left, y })
    out.push({ x: right, y })
  }
  return out.filter((t) => isInBounds(w, t.x, t.y) && t.y >= BACK_WALL_ROWS)
}

function isInteriorSectionCarved(w: WorldState): boolean {
  const targets = buildInteriorSectionWallTargets(w)
  return targets.length > 0 && targets.every((t) => hasWallPieceAt(w, t.x, t.y))
}

function familyCount(w: WorldState, family: 'couch' | 'plant' | 'wall_art' | 'trash' | 'table' | 'water'): number {
  return w.items.filter((item) => {
    const id = normalizeDefId(item.defId)
    if (family === 'couch') return id === 'couch' || id === 'couch_white' || id === 'couch_green' || id === 'couch_yellow'
    if (family === 'plant') return id === 'plant' || id === 'plant_bushy' || id === 'plant_large'
    if (family === 'wall_art') return id.startsWith('wall_art')
    if (family === 'trash') return id === 'trashcan' || id === 'trashcan_red' || id === 'recycling_bin'
    if (family === 'table') return id === 'table_small' || id === 'table_large'
    if (family === 'water') return id === 'watercooler'
    return false
  }).length
}

function countPostIts(w: WorldState): number {
  return w.items.filter((i) => normalizeDefId(i.defId) === 'post_its').length
}
function countMemo(w: WorldState): number {
  return w.items.filter((i) => {
    const id = normalizeDefId(i.defId)
    return id === 'wall_art_memo_a' || id === 'wall_art_memo_b'
  }).length
}
function countBackWallMemo(w: WorldState): number {
  return w.items.filter((i) => {
    const id = normalizeDefId(i.defId)
    if (id !== 'wall_art_memo_a' && id !== 'wall_art_memo_b') return false
    return i.y < BACK_WALL_ROWS
  }).length
}
function countBackWallWallArt(w: WorldState): number {
  return w.items.filter((i) => i.defId.startsWith('wall_art') && i.y < BACK_WALL_ROWS).length
}
function countBookshelf(w: WorldState): number {
  return w.items.filter((i) => i.defId === 'bookshelf').length
}
function countVending(w: WorldState): number {
  return w.items.filter((i) => i.defId === 'vending_machine').length
}

function countBlockedFloorCells(w: WorldState): number {
  let blocked = 0
  for (let y = BACK_WALL_ROWS; y < w.gridHeight; y++) {
    for (let x = 0; x < w.gridWidth; x++) {
      if (isCellBlockedForAgents(w, x, y)) blocked++
    }
  }
  return blocked
}

function isLayoutSaturated(w: WorldState): boolean {
  const floorArea = Math.max(1, w.gridWidth * (w.gridHeight - BACK_WALL_ROWS))
  const walk = getWalkableStats(w)
  const blockedCells = countBlockedFloorCells(w)
  const blockedRatio = blockedCells / floorArea
  const walkableRatio = walk.total / floorArea
  const connectivityRatio = walk.total > 0 ? walk.largestRegion / walk.total : 0

  const slots = getDeskSlotsInOrder(w)
  const slotStats = slots.map((slot) => getSlotCompletion(w, slot))
  const essentialComplete =
    slots.length > 0 &&
    slotStats.every((s) => s.hasChair && s.hasComputer)

  const amenityScore =
    (familyCount(w, 'table') > 0 ? 1 : 0) +
    (familyCount(w, 'couch') > 0 ? 1 : 0) +
    (familyCount(w, 'water') > 0 ? 1 : 0) +
    (w.items.some((i) => i.defId === 'bookshelf' || i.defId === 'vending_machine') ? 1 : 0)

  const clutterStop =
    blockedRatio >= 0.42 ||
    walkableRatio < 0.45 ||
    connectivityRatio < 0.93
  if (clutterStop) return true

  // "Done enough": seats complete + basic amenities + healthy walkability.
  if (essentialComplete && amenityScore >= 2 && blockedRatio >= 0.30 && walkableRatio >= 0.50 && connectivityRatio >= 0.95) {
    return true
  }
  return false
}

function getBlueprintWallTopTargets(w: WorldState): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  const key = (x: number, y: number) => `${x},${y}`
  const seen = new Set<string>()
  const push = (x: number, y: number) => {
    if (!isInBounds(w, x, y)) return
    const k = key(x, y)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ x, y })
  }

  // 1) Back wall stripe.
  const backWallY = BACK_WALL_ROWS - 1
  for (let x = 0; x < w.gridWidth; x++) push(x, backWallY)

  // 2) Perimeter (left/east/south), keep one 2-cell doorway on south edge.
  const southY = w.gridHeight - 1
  const southDoorStart = Math.max(1, Math.floor((w.gridWidth - 2) / 2))
  for (let y = BACK_WALL_ROWS; y <= southY; y++) {
    push(0, y)
    push(w.gridWidth - 1, y)
  }
  for (let x = 0; x < w.gridWidth; x++) {
    if (x >= southDoorStart && x <= southDoorStart + 1) continue
    push(x, southY)
  }

  // 3) Interior section carve-out (at least 8x5 interior).
  for (const t of buildInteriorSectionWallTargets(w)) push(t.x, t.y)
  return out
}

function scoreCandidate(
  w: WorldState,
  defId: string,
  x: number,
  y: number,
  baseline: WalkableStats
): number {
  const def = getItemDef(w, defId)
  if (!def) return Number.NEGATIVE_INFINITY
  const [fw, fh] = def.footprint
  const cells = getPlacementCellsForDef(w, defId, x, y)
  let score = 0

  if (shouldProtectConnectivity(defId)) {
    const afterWorld = withHypotheticalPlacement(w, defId, x, y)
    const after = getWalkableStats(afterWorld)
    const baselineLargest = Math.max(1, baseline.largestRegion)
    const largestRatio = after.largestRegion / baselineLargest
    if (largestRatio < 0.78) return Number.NEGATIVE_INFINITY
    score += (after.largestRegion - baseline.largestRegion) * 0.1
    score += (after.total - baseline.total) * 0.05
  }

  const localBlockers = countLocalBlockingItems(w, x, y, fw, fh)
  score -= localBlockers * 2

  if (isStructuralWallPiece(defId)) {
    const onBackWall = y === BACK_WALL_ROWS - 1
    const onPerimeter = x === 0 || x === w.gridWidth - 1 || y === w.gridHeight - 1
    if (onBackWall) score += 120
    if (onPerimeter) score += 55
    const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].reduce((sum, [dx, dy]) => {
      const nx = x + dx
      const ny = y + dy
      return sum + (hasWallPieceAt(w, nx, ny) ? 1 : 0)
    }, 0)
    score += adj * 9
    return score
  }

  // Even spacing: prefer symmetric left/right margins for workstations.
  if (defId === 'workstation') {
    const afterWorld = withHypotheticalPlacement(w, 'workstation', x, y)
    const edges = [...new Set(afterWorld.items.filter((i) => i.defId === 'workstation').map((i) => i.x))].sort((a, b) => a - b)
    if (edges.length > 0) {
      const leftMargin = edges[0]!
      const rightMargin = w.gridWidth - 5 - edges[edges.length - 1]!
      score -= Math.abs(leftMargin - rightMargin) * 4
    }
  }

  if (isAmenityOrDecor(defId)) {
    const distToDesk = minDistanceToWorkstations(w, cells)
    score += Math.min(8, distToDesk) * 1.25
    if (distToDesk < 2) score -= 14
  }

  if (defId.startsWith('wall_art')) {
    score += y === BACK_WALL_ROWS - 1 ? 18 : 0
  }

  if (defId.startsWith('plant') || defId === 'watercooler' || defId.startsWith('couch')) {
    const edgeDist = Math.min(x, w.gridWidth - 1 - x, y - BACK_WALL_ROWS, w.gridHeight - 1 - y)
    score += Math.max(0, 4 - edgeDist) * 2
  }

  return score
}

function pickBestPlacementTile(
  w: WorldState,
  defId: string,
  tiles: Array<{ x: number; y: number }>,
  baseline: WalkableStats
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const tile of tiles) {
    const s = scoreCandidate(w, defId, tile.x, tile.y, baseline)
    if (s > bestScore) {
      bestScore = s
      best = tile
    }
  }
  return best
}

/**
 * Linear build pipeline:
 * 1) Workstations for each agent
 * 2) Fill ALL chair slots on those workstations (left + right)
 * 3) Fill ALL computer slots (chair before computer per side)
 * 4) Add amenities/decor in deterministic order
 */
function getNextProposalFromWorld(w: WorldState): { defId: string; x: number; y: number } | null {
  const placeable = (w.itemDefs ?? []).map((d) => d.id)
  const canPlace = (defId: string) =>
    placeable.includes(defId) &&
    (!getItemDef(w, defId)?.requiresUnlock || (w.unlockedTech ?? []).includes(getItemDef(w, defId)!.requiresUnlock!))
  const baselineWalkable = getWalkableStats(w)
  const minWorkstations = Math.max(3, w.agents.length)
  const maxWorkstations = 6
  const wsCount = w.items.filter((i) => i.defId === 'workstation').length

  // 1) Add workstations until we have at least 3 (or one per agent); more can be added later in round robin.
  if (wsCount < minWorkstations && canPlace('workstation')) {
    const tiles = getValidPlacementTiles(w, 'workstation')
    if (tiles.length > 0) {
      const best = pickBestPlacementTile(w, 'workstation', tiles, baselineWalkable) ?? tiles[0]!
      const { x, y } = best
      return { defId: 'workstation', x, y }
    }
  }

  // 2) Fill every chair slot (both sides of each desk), in stable desk order.
  const slots = getDeskSlotsInOrder(w)
  if (slots.length > 0 && canPlace('chair')) {
    for (const slot of slots) {
      const comp = getSlotCompletion(w, slot)
      if (!comp.hasChair) {
        // Do not skip desk-slot completion due transient agent occupancy.
        // If builder is blocking, reducer returns AGENT_IN_THE_WAY and retries.
        return { defId: 'chair', x: slot.chairX, y: slot.chairY }
      }
    }
  }

  // 3) Fill every computer slot (left + right), but only after chair exists for that side.
  if (slots.length > 0 && canPlace('computer')) {
    for (const slot of slots) {
      const comp = getSlotCompletion(w, slot)
      if (comp.hasChair && !comp.hasComputer) {
        // Same as chairs: prioritize deterministic desk completion even when temporarily blocked.
        return { defId: 'computer', x: slot.computerX, y: slot.computerY }
      }
    }
  }

  // 4) Build only the basic wall plan (back wall stripe + perimeter + one section), then switch to objects.
  // Use allowPerimeterWallTop so blueprint perimeter (with 2-cell doorway) is valid for proposal.
  if (canPlace('wall_top')) {
    const tiles = getValidPlacementTiles(w, 'wall_top', { allowPerimeterWallTop: true })
    if (tiles.length > 0) {
      const tileSet = new Set(tiles.map((t) => `${t.x},${t.y}`))
      const neededTargets = getBlueprintWallTopTargets(w)
      for (const target of neededTargets) {
        if (hasWallPieceAt(w, target.x, target.y)) continue
        if (!tileSet.has(`${target.x},${target.y}`)) continue
        return { defId: 'wall_top', x: target.x, y: target.y }
      }
    }
  }

  // 5) Fill office amenities/decor with curated caps to avoid clutter. Workstation can be added after 3 primary (round robin).
  const amenityOrder: string[] = [
    'workstation',
    'table_large',
    'table_small',
    'bookshelf',
    'vending_machine',
    'watercooler',
    'coffee_maker',
    'printer',
    'post_its',
    'recycling_bin',
    'trashcan',
    'trashcan_red',
    'plant',
    'plant_bushy',
    'plant_large',
    'coffee_left',
    'coffee_right',
    'couch',
    'couch_white',
    'couch_green',
    'couch_yellow',
    // Keep wall art late and only after enough wall_top structure exists.
    'wall_art',
    'wall_art_sun',
    'wall_art_sunset',
    'wall_art_sun_rise',
    'wall_art_usa_flag',
    'wall_art_england_flag',
    'wall_art_india_flag',
    'wall_art_memo_a',
    'wall_art_memo_b',
  ]
  const proposedAlready = new Set(
    w.artifacts
      .filter((a) => a.type === 'Proposal')
      .map((a) => normalizeDefId(String((a.payload as { defId?: string })?.defId ?? '')))
      .filter((id) => id.length > 0)
  )
  const presentCounts = new Map<string, number>()
  for (const item of w.items) {
    const id = normalizeDefId(item.defId)
    presentCounts.set(id, (presentCounts.get(id) ?? 0) + 1)
  }
  const MAX_BACK_WALL_ART = 6
  for (const defId of amenityOrder) {
    if (!canPlace(defId)) continue
    if (defId === 'workstation') {
      if (wsCount >= maxWorkstations) continue
      if (wsCount < minWorkstations) continue
    }
    if (defId.startsWith('wall_art') && !isInteriorSectionCarved(w)) continue
    if ((defId === 'couch' || defId === 'couch_white' || defId === 'couch_green' || defId === 'couch_yellow') && familyCount(w, 'couch') >= 1) continue
    if ((defId === 'plant' || defId === 'plant_bushy' || defId === 'plant_large') && familyCount(w, 'plant') >= 3) continue
    if (defId === 'bookshelf' && countBookshelf(w) >= 3) continue
    if (defId === 'vending_machine' && countVending(w) >= 2) continue
    if (defId === 'watercooler' && familyCount(w, 'water') >= 2) continue
    if (defId === 'post_its' && countPostIts(w) >= 5) continue
    if (defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') {
      if (countMemo(w) >= 4) continue
      if (countBackWallMemo(w) >= 2) {
        const tiles = getValidPlacementTiles(w, defId).filter((t) => t.y >= BACK_WALL_ROWS)
        if (tiles.length === 0) continue
        const best = pickBestPlacementTile(w, defId, tiles, baselineWalkable) ?? tiles[0]!
        return { defId, x: best.x, y: best.y }
      }
    }
    if ((defId.startsWith('wall_art') && defId !== 'wall_art_memo_a' && defId !== 'wall_art_memo_b') && countBackWallWallArt(w) >= MAX_BACK_WALL_ART) continue
    if (defId === 'trashcan' && w.items.filter((i) => i.defId === 'trashcan').length >= 2) continue
    if (defId === 'trashcan_red' && w.items.filter((i) => i.defId === 'trashcan_red').length >= 2) continue
    if (defId === 'recycling_bin' && w.items.filter((i) => i.defId === 'recycling_bin').length >= 2) continue
    if ((defId === 'table_small' || defId === 'table_large') && familyCount(w, 'table') >= 4) continue
    if (defId === 'printer' && w.items.filter((i) => i.defId === 'printer').length >= 4) continue
    const isMultiPlace =
      defId === 'workstation' ||
      defId === 'post_its' ||
      defId === 'wall_art_memo_a' ||
      defId === 'wall_art_memo_b' ||
      defId === 'trashcan' ||
      defId === 'trashcan_red' ||
      defId === 'recycling_bin' ||
      defId === 'table_small' ||
      defId === 'table_large' ||
      defId === 'printer'
    if (!isMultiPlace && ((presentCounts.get(defId) ?? 0) > 0 || proposedAlready.has(defId))) continue
    const tiles = getValidPlacementTiles(w, defId)
    if (tiles.length > 0) {
      let useTiles = tiles
      if ((defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') && countBackWallMemo(w) >= 2) {
        useTiles = tiles.filter((t) => t.y >= BACK_WALL_ROWS)
        if (useTiles.length === 0) continue
      }
      const best = pickBestPlacementTile(w, defId, useTiles, baselineWalkable) ?? useTiles[0]!
      const { x, y } = best
      return { defId, x, y }
    }
  }

  // 6) Stop adding once layout is saturated / done enough.
  if (isLayoutSaturated(w)) return null

  // 7) Small tail pass: only low-impact finishing touches; caps to avoid waste (post_its 5, memos 4, back wall memos 2).
  for (const defId of ['post_its', 'wall_art_memo_a', 'wall_art_memo_b']) {
    if (!canPlace(defId)) continue
    if (defId === 'post_its' && countPostIts(w) >= 5) continue
    if ((defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') && countMemo(w) >= 4) continue
    let tiles = getValidPlacementTiles(w, defId)
    if ((defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') && countBackWallMemo(w) >= 2) {
      tiles = tiles.filter((t) => t.y >= BACK_WALL_ROWS)
    }
    if (tiles.length > 0) {
      const best = pickBestPlacementTile(w, defId, tiles, baselineWalkable) ?? tiles[0]!
      return { defId, x: best.x, y: best.y }
    }
  }
  return null
}

/** Cells that would be occupied by placing defId at (x, y). Used to check if builder is in the way. */
function getPlacementFootprintCells(w: WorldState, defId: string, x: number, y: number): Array<[number, number]> {
  if (defId === 'workstation') return getWorkstationCells(x, y)
  const def = getItemDef(w, defId)
  if (!def) return [[x, y]]
  const [w2, h] = def.footprint
  const out: Array<[number, number]> = []
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w2; dx++) out.push([x + dx, y + dy])
  return out
}

/** Find a cell adjacent to the placement footprint that is free (in bounds, walkable, no other agent). If none, fallback to any free floor cell so the builder can always move off. */
function findFreeCellNextToFootprint(
  w: WorldState,
  builderId: string,
  footprintCells: Array<[number, number]>
): { x: number; y: number } | null {
  const footprintSet = new Set(footprintCells.map(([a, b]) => `${a},${b}`))
  const tried = new Set<string>()
  for (const [fx, fy] of footprintCells) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const cx = fx + dx
      const cy = fy + dy
      const key = `${cx},${cy}`
      if (tried.has(key) || footprintSet.has(key)) continue
      tried.add(key)
      if (!isInBounds(w, cx, cy) || isCellBlockedForAgents(w, cx, cy)) continue
      const otherAgent = w.agents.some((a) => a.id !== builderId && Math.floor(a.x) === cx && Math.floor(a.y) === cy)
      if (otherAgent) continue
      return { x: cx, y: cy }
    }
  }
  // Fallback: any free floor cell not in footprint so builder can move off and placement can succeed
  for (let y = BACK_WALL_ROWS; y < (w.gridHeight ?? 15); y++) {
    for (let x = 0; x < (w.gridWidth ?? 20); x++) {
      if (footprintSet.has(`${x},${y}`)) continue
      if (isCellBlockedForAgents(w, x, y)) continue
      const otherAgent = w.agents.some((a) => a.id !== builderId && Math.floor(a.x) === x && Math.floor(a.y) === y)
      if (otherAgent) continue
      return { x, y }
    }
  }
  return null
}

/**
 * Move any agents (except builder) off the target footprint so queue placement does not stall forever.
 * Returns true when at least one agent was moved.
 */
function moveBlockingAgentsOffFootprint(
  builderId: string,
  footprintCells: Array<[number, number]>
): boolean {
  const footprintSet = new Set(footprintCells.map(([x, y]) => `${x},${y}`))
  const blocking = worldState.agents.filter(
    (a) => a.id !== builderId && footprintSet.has(`${Math.floor(a.x)},${Math.floor(a.y)}`)
  )
  let movedAny = false
  for (const blocker of blocking) {
    const freeCell = findFreeCellNextToFootprint(worldState, blocker.id, footprintCells)
    if (!freeCell) continue
    const moved = applyAction({ type: 'MOVE_AGENT', agentId: blocker.id, x: freeCell.x, y: freeCell.y })
    if (moved) movedAny = true
  }
  return movedAny
}

function moveBuilderOffFootprint(
  builderId: string,
  footprintCells: Array<[number, number]>
): boolean {
  const builder = worldState.agents.find((a) => a.id === builderId)
  if (!builder) return false
  const footprintSet = new Set(footprintCells.map(([x, y]) => `${x},${y}`))
  const builderCellKey = `${Math.floor(builder.x)},${Math.floor(builder.y)}`
  if (!footprintSet.has(builderCellKey)) return false
  const freeCell = findFreeCellNextToFootprint(worldState, builderId, footprintCells)
  if (!freeCell) return false
  return applyAction({ type: 'MOVE_AGENT', agentId: builderId, x: freeCell.x, y: freeCell.y })
}

/* -------------------------------------------------------------------------- */
/* AGENT BRAIN (LLM TURN → ACTIONS)                                            */
/* -------------------------------------------------------------------------- */

function toSnapshot(w: WorldState): SnapshotWorld {
  return {
    tick: w.tick,
    gridWidth: w.gridWidth,
    gridHeight: w.gridHeight,
    agents: w.agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      x: a.x,
      y: a.y,
      currentIntent: a.currentIntent,
    })),
    items: w.items.map((i) => ({ defId: normalizeDefId(i.defId), x: i.x, y: i.y })),
    itemDefs: w.itemDefs,
    artifacts: w.artifacts.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      authorAgentId: a.authorAgentId,
      payload: a.payload,
    })),
    artifactVotes: w.artifactVotes,
    executedProposalIds: w.executedProposalIds,
    rejectedProposalIds: w.rejectedProposalIds,
    cells: w.cells?.map((c) => ({ x: c.x, y: c.y, kind: c.kind, floorPaint: c.floorPaint, wallPaint: c.wallPaint })),
    unlockedTech: w.unlockedTech,
    chatLog: w.chatLog,
    scores: w.scores,
    layoutSaturated: isLayoutSaturated(w),
  }
}

/** Parsed legible name for a source: title if present, else domain from URL. */
function legibleSourceName(url: string, title?: string | null): string {
  if (title != null && String(title).trim()) return String(title).trim().slice(0, 80)
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 50)
  }
}

function isDirectDecorDefId(defId: string): boolean {
  const n = normalizeDefId(defId)
  return isStructuralWallPiece(n) || n === 'floor'
}

/** Run Builder placement from queue without calling the LLM (saves one API call per placement). */
async function runBuilderPlacementOnly(agent: WorldState['agents'][0]): Promise<void> {
  eventIndexThisTick = 0
  worldState = updateScoresFromWorld(worldState)
  const firstUnexecuted = getFirstUnexecutedProposal(worldState)
  if (!firstUnexecuted) return
  const p = firstUnexecuted.payload as { defId?: string; action?: string; x?: number; y?: number }
  if (p?.action === 'paint_floor' || p?.action === 'paint_wall' || p?.defId == null || p?.x == null || p?.y == null) return
  // Payload is stored in engine coords (x, y)
  const builderMustPlace = { defId: normalizeDefId(p.defId), x: Number(p.x), y: Number(p.y) }

  log('AGENT', 'builder placement (no LLM)', { agent: agent.name, defId: builderMustPlace.defId })
  worldState = advanceTick(worldState)
  applyAction({ type: 'SET_INTENT', agentId: agent.id, intent: 'place_item' })
  const placeX = builderMustPlace.x
  const placeY = builderMustPlace.y
  const defId = builderMustPlace.defId
  const footprintCells = getPlacementFootprintCells(worldState, defId, placeX, placeY)
  if (moveBuilderOffFootprint(agent.id, footprintCells)) {
    log('AGENT', 'moved builder off placement footprint', { agent: agent.name, defId, placeX, placeY })
  }
  if (moveBlockingAgentsOffFootprint(agent.id, footprintCells)) {
    log('AGENT', 'moved blocking agents off placement footprint', { agent: agent.name, defId, placeX, placeY })
  }
  const placed = applyAction({
    type: 'PLACE_ITEM',
    agentId: agent.id,
    defId: builderMustPlace.defId,
    x: placeX,
    y: placeY,
    flipped: undefined,
  })
  if (placed) {
    const sayIndex = worldState.tick % BUILDER_SAY_AFTER_PLACE.length
    applyAction({ type: 'SAY', agentId: agent.id, text: BUILDER_SAY_AFTER_PLACE[sayIndex]! })
  }
  applyAction({ type: 'SET_INTENT', agentId: agent.id, intent: 'hold' })
  worldState = updateScoresFromWorld(worldState)
  broadcastWorld()
}

const BUILDER_SAY_AFTER_PLACE = ['Done.', 'There.', 'Placed.', 'Done and done.', 'There you go.']

/** Add one proposal from valid spots without calling the LLM (saves one API call). */
async function runArchitectProposalOnly(agent: WorldState['agents'][0]): Promise<void> {
  eventIndexThisTick = 0
  worldState = updateScoresFromWorld(worldState)
  const next = getNextProposalFromWorld(worldState)
  if (!next) return
  log('AGENT', 'architect proposal (no LLM)', { agent: agent.name, defId: next.defId, x: next.x, y: next.y })
  worldState = advanceTick(worldState)
  applyAction({ type: 'SET_INTENT', agentId: agent.id, intent: 'propose' })
  applyAction({ type: 'SAY', agentId: agent.id, text: 'Adding that to the queue.' })
  applyAction({
    type: 'CREATE_ARTIFACT',
    agentId: agent.id,
    artifactType: 'Proposal',
    title: undefined,
    payload: { defId: next.defId, x: next.x, y: next.y },
  })
  lastProposalAddedTick = worldState.tick
  worldState = updateScoresFromWorld(worldState)
  broadcastWorld()
}

/** Run one agent's LLM turn (async). Advance tick only after getAgentTurn succeeds so 402/400 retry same agent. */
async function runAgentTurn(agent: WorldState['agents'][0]): Promise<void> {
  eventIndexThisTick = 0
  worldState = updateScoresFromWorld(worldState)

  log('AGENT', 'turn start', { tick: worldState.tick, agent: agent.name, role: agent.role })
  const agents = worldState.agents
  const agentIndex = agents.findIndex((a) => a.id === agent.id)
  const snapshot = toSnapshot(worldState)
  const layoutSaturated = isLayoutSaturated(worldState)
  const isWarmup = worldState.tick < WARMUP_TICKS
  const firstUnexecuted = getFirstUnexecutedProposal(worldState)
  const votesOnFirst = firstUnexecuted ? (worldState.artifactVotes ?? {})[firstUnexecuted.id] ?? {} : {}
  const hasVotedOnFirst = firstUnexecuted ? votesOnFirst[agent.id] != null : false
  const tavilyOk = Boolean((process.env.TAVILY_API_KEY ?? '').trim() && (worldState.unlockedTech ?? []).includes('tavily_research'))
  const pixellabOk = Boolean((process.env.PIXELLAB_API_TOKEN ?? process.env.PIXELLAB_API_KEY ?? '').trim())
  const pixellabRoleAllowed = agent.role === 'Architect' || agent.role === 'Builder'

  const chatLog = worldState.chatLog ?? []
  const lastSay = [...chatLog].reverse().find((e) => e.kind === 'say' && e.agentId !== agent.id)
  const agentRecentSays = chatLog.filter((e) => e.agentId === agent.id && e.kind === 'say').slice(-5).map((e) => e.text)

  const allSlots = getDeskSlotsInOrder(worldState)
  const shuffledSlots = shuffleSlotsForAssignment(allSlots, worldState)
  const assignedSlot = shuffledSlots[agentIndex] ?? null
  const slotCompletion = assignedSlot
    ? getSlotCompletion(worldState, assignedSlot)
    : null
  const assignedWorkstation =
    assignedSlot && slotCompletion
      ? {
          x: assignedSlot.desk.x,
          y: assignedSlot.desk.y,
          side: assignedSlot.side,
          chairX: assignedSlot.chairX,
          chairY: assignedSlot.chairY,
          computerX: assignedSlot.computerX,
          computerY: assignedSlot.computerY,
          needsChair: !slotCompletion.hasChair,
          needsComputer: !slotCompletion.hasComputer,
        }
      : null

  const builderMustPlace =
    agent.role === 'Builder' && firstUnexecuted
      ? (() => {
          const p = firstUnexecuted.payload as { defId?: string; action?: string; x?: number; y?: number }
          if (p?.action === 'paint_floor' || p?.action === 'paint_wall') return undefined
          if (p?.defId == null || p?.x == null || p?.y == null) return undefined
          return { defId: normalizeDefId(p.defId), x: Number(p.x), y: Number(p.y) }
        })()
      : undefined

  /** Nudge Nova: strong for first report (computer just placed); after that, less frequent (round-robin). */
  const RESEARCH_NUDGE_TICKS_FIRST = 24
  const RESEARCH_NUDGE_TICKS_SUBSEQUENT = 56
  const researchReports = (worldState.artifacts ?? []).filter(
    (a: { type: string }) => a.type === 'ResearchReport'
  ) as Array<{ createdAtTick: number }>
  const lastResearchTick =
    researchReports.length > 0
      ? Math.max(...researchReports.map((a) => a.createdAtTick))
      : 0
  const ticksSinceLastResearch = worldState.tick - lastResearchTick
  const researcherNudgeResearch =
    agent.role === 'Researcher' &&
    tavilyOk &&
    !isWarmup &&
    (researchReports.length === 0 ||
      ticksSinceLastResearch >= (researchReports.length > 0 ? RESEARCH_NUDGE_TICKS_SUBSEQUENT : RESEARCH_NUDGE_TICKS_FIRST))
  const researcherFirstReportDue = tavilyOk && researchReports.length === 0

  const pipelineContext = {
    latestProposalId: firstUnexecuted?.id,
    canVote: firstUnexecuted != null,
    hasVotedOnLatestProposal: hasVotedOnFirst,
    isWarmupPhase: isWarmup,
    warmupTicksLeft: Math.max(0, WARMUP_TICKS - worldState.tick),
    otherAgents: agents.filter((a) => a.id !== agent.id).map((a) => ({ name: a.name, role: a.role })),
    model: getModelForRole(agent.role),
    personality: getPersonalityForRole(agent.role),
    conversationPhase: getConversationPhase(snapshot, isWarmup),
    isSpeakerThisTick: true,
    lastSpeakerName: lastSay?.agentName,
    lastSpeakerLine: lastSay?.text,
    tavilyToolsAvailable: tavilyOk,
    pixellabToolsAvailable: pixellabOk && pixellabRoleAllowed,
    agentMemoryText: formatAgentMemory(agent.memory),
    assignedWorkstation,
    gridHeight: worldState.gridHeight,
    loadedSkills: agent.loadedSkills ?? [],
    builderMustPlace,
    researcherNudgeResearch: researcherNudgeResearch || undefined,
    researcherFirstReportDue: researcherFirstReportDue || undefined,
    researcherTavilyInFlight: researcherTavilyInFlight || undefined,
    layoutSaturated: layoutSaturated || undefined,
  }

  const lastPlacementFailure = (() => {
    const events = worldState.lastEvents ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const a = ev?.action as Action & { type?: string; reason?: string; attemptedAction?: Action }
      if (a?.type === 'FAIL_ACTION' && (a.attemptedAction as Action & { type?: string })?.type === 'PLACE_ITEM' && a.reason) {
        return a.reason
      }
    }
    return undefined
  })()
  const lastProposalRejectionRaw = (() => {
    const events = worldState.lastEvents ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const a = ev?.action as Action & { type?: string; reason?: string; attemptedAction?: Action }
      if (a?.type === 'FAIL_ACTION' && (a.attemptedAction as Action & { type?: string; artifactType?: string })?.type === 'CREATE_ARTIFACT' && (a.attemptedAction as { artifactType?: string })?.artifactType === 'Proposal' && a.reason) {
        return a.reason
      }
    }
    return undefined
  })()
  // Only block Architect when queue is actually full. Once Builder places one, queue has room — don't keep showing "Do NOT add".
  const queueCount = getUnexecutedProposalCount(worldState)
  const lastProposalRejection =
    lastProposalRejectionRaw != null &&
    (!lastProposalRejectionRaw.includes('Build queue is full') || queueCount >= 2)
      ? lastProposalRejectionRaw
      : undefined
  const pipelineContextWithRejection = { ...pipelineContext, lastProposalRejection }
  const reality = getRealitySummary(snapshot)
  log('STATE', 'authoritative snapshot sent to LLM (desk status)', {
    tick: worldState.tick,
    agent: agent.name,
    workstations: reality.workstations,
    chairs: reality.chairs,
    computers: reality.computers,
    deskStatus: reality.deskStatus,
  })
  const worldSnapshotStr = buildWorldSnapshot(snapshot, undefined, isWarmup, lastPlacementFailure)

  let turn
  if (!llmEnabled) {
    turn = { say: '', thought: 'LLM off (debug mode).', action: 'hold' }
    log('AGENT', 'stub turn (LLM disabled)', { agent: agent.name })
  } else {
    const sinceLastLlm = lastLlmRequestAt > 0 ? Date.now() - lastLlmRequestAt : MIN_LLM_REQUEST_GAP_MS
    if (sinceLastLlm < MIN_LLM_REQUEST_GAP_MS) {
      const waitMs = MIN_LLM_REQUEST_GAP_MS - sinceLastLlm
      log('SCHEDULER', 'throttle_llm', { waitMs, agent: agent.name, sinceLastLlm })
      await new Promise((r) => setTimeout(r, waitMs))
    }
    lastLlmRequestAt = Date.now()
    turn = await getAgentTurn(agent.name, agent.role, worldSnapshotStr, pipelineContextWithRejection, agentRecentSays)
  }
  // Fallback queue placement when Builder omitted placeItem.
  if (agent.role === 'Builder' && builderMustPlace) {
    const hasPlace = turn.placeItem?.defId != null && turn.placeItem?.x != null && turn.placeItem?.y != null
    if (!hasPlace) {
      turn.placeItem = { defId: builderMustPlace.defId, x: builderMustPlace.x, y: builderMustPlace.y }
      log('AGENT', 'builder place fallback from queue (LLM omitted placeItem)', { agent: agent.name, defId: builderMustPlace.defId })
    }
  }
  worldState = advanceTick(worldState)

  log('LLM', 'turn output', {
    agent: agent.name,
    sayLen: (turn.say ?? '').length,
    action: (turn.action ?? '').slice(0, 80),
    placeItem: turn.placeItem ? { defId: turn.placeItem.defId, x: turn.placeItem.x, y: turn.placeItem.y } : undefined,
    vote: turn.vote,
    createArtifact: turn.createArtifact ? turn.createArtifact.artifactType : undefined,
  })

  // Apply actions in order
  applyAction({ type: 'SET_INTENT', agentId: agent.id, intent: turn.action })

  let sayText = truncateSay(filterBannedPhrases(turn.say ?? ''))
  const normalizedSay = (sayText ?? '').replace(/\s+/g, ' ').trim()

  // When there are ZERO workstations, do not allow dialogue that refers to workstations/desks/chairs as if they exist.
  if (sayText && reality.workstations === 0) {
    const impliesObjectsExist =
      /\b(both|all|each|the)\s+(workstations?|desks?)\b/i.test(normalizedSay) ||
      /\bworkstations?\s+(are|is)\s+(set|done|ready)\b/i.test(normalizedSay) ||
      /\b(left|right)[-\s]?(side\s+)?chairs?\b/i.test(normalizedSay) ||
      /\bfill\s+(in\s+)?(left|right|both)\s+chairs?\b/i.test(normalizedSay) ||
      /\bchairs?\s+(next|to complete)\b/i.test(normalizedSay) ||
      /\bdesks?\s+(have|need)\s+chairs?\b/i.test(normalizedSay)
    if (impliesObjectsExist) {
      log('AGENT', 'say suppressed (refers to workstations/desks/chairs but REALITY has zero)', {
        agent: agent.name,
        was: sayText.trim().slice(0, 100),
      })
      sayText = ''
    }
  }

  // Do not let dialogue claim all chairs/desks are done when PER-DESK STATUS has chair MISSING.
  const claimsAllChairsOrDesksComplete =
    normalizedSay &&
    reality.workstations > 0 &&
    (
      /chairs?\s+on\s+both\s+sides?/i.test(normalizedSay) ||
      /all\s+(four|five|\d+)\s+desks?\s+(now\s+)?have\s+chairs?/i.test(normalizedSay) ||
      /all\s+(four|five|\d+)\s+workstations?\s+(now\s+)?have\s+chairs?/i.test(normalizedSay) ||
      /every\s+desk\s+has\s+chairs?/i.test(normalizedSay) ||
      /all\s+desks?\s+now\s+have\s+chairs?/i.test(normalizedSay) ||
      /all\s+chairs?\s+done/i.test(normalizedSay) ||
      /\bchairs?\s+done\b/i.test(normalizedSay)
    )
  const hasChairMissing = reality.deskStatus.includes('chair MISSING')
  const claimsAllComputersComplete =
    normalizedSay &&
    reality.workstations > 0 &&
    (
      /all\s+(four|five|\d+)\s+desks?\s+(now\s+)?have\s+computers?/i.test(normalizedSay) ||
      /all\s+(four|five|\d+)\s+workstations?\s+(now\s+)?have\s+computers?/i.test(normalizedSay) ||
      /every\s+desk\s+has\s+computers?/i.test(normalizedSay) ||
      /all\s+computers?\s+done/i.test(normalizedSay) ||
      /\bcomputers?\s+done\b/i.test(normalizedSay)
    )
  const hasComputerMissing = reality.deskStatus.includes('computer MISSING')
  const claimsDecorFollowup =
    /\b(plants?|decor|amenities|watercooler|vending|couch|wall art)\b/i.test(normalizedSay) &&
    /\b(now|next|ready|let'?s|we can)\b/i.test(normalizedSay)
  if (sayText && claimsAllChairsOrDesksComplete && hasChairMissing) {
    log('AGENT', 'say suppressed (claimed all chairs/desks complete but PER-DESK has chair MISSING)', {
      agent: agent.name,
      was: sayText.trim().slice(0, 100),
      deskStatus: reality.deskStatus,
    })
    sayText = ''
  }
  if (sayText && claimsAllComputersComplete && hasComputerMissing) {
    log('AGENT', 'say suppressed (claimed all computers complete but PER-DESK has computer MISSING)', {
      agent: agent.name,
      was: sayText.trim().slice(0, 100),
      deskStatus: reality.deskStatus,
    })
    sayText = ''
  }
  if (sayText && claimsDecorFollowup && (hasChairMissing || hasComputerMissing)) {
    log('AGENT', 'say suppressed (decor follow-up while desk slots incomplete)', {
      agent: agent.name,
      was: sayText.trim().slice(0, 100),
      deskStatus: reality.deskStatus,
    })
    sayText = ''
  }
  // Builder must not say "Done." / "Placed." etc. when we're not actually placing this turn.
  const queueHasProposalForSay = getFirstUnexecutedProposal(worldState) != null
  const builderDirectDecorForSay =
    agent.role === 'Builder' &&
    turn.placeItem?.defId != null &&
    (isStructuralWallPiece(normalizeDefId(turn.placeItem.defId)) || normalizeDefId(turn.placeItem.defId) === 'floor')
  const builderWillPlaceThisTurn =
    agent.role === 'Builder' &&
    turn.placeItem?.defId != null &&
    turn.placeItem?.x != null &&
    turn.placeItem?.y != null &&
    (queueHasProposalForSay || builderDirectDecorForSay)
  const builderPlacementPhrase = /^(done\.?|there\.?|placed\.?|occupied\.?\s*next\.?|next\.?|got it\.?|on it\.?)$/i.test(sayText.trim())
  if (agent.role === 'Builder' && sayText && builderPlacementPhrase && !builderWillPlaceThisTurn) {
    log('AGENT', 'builder say suppressed (no placement this turn)', { agent: agent.name, was: sayText.trim() })
    sayText = ''
  }
  if (sayText) {
    applyAction({ type: 'SAY', agentId: agent.id, text: sayText })
  } else {
    const rawSay = (turn.say ?? '').trim()
    if (rawSay) {
      log('LLM', 'say filtered out (banned phrase)', { agent: agent.name, sayLen: rawSay.length })
    } else {
      log('LLM', 'model returned empty say', { agent: agent.name })
    }
  }

  if (turn.remember?.content) {
    applyAction({
      type: 'ADD_MEMORY',
      agentId: agent.id,
      content: turn.remember.content,
      importance: turn.remember.importance ?? 0.5,
    })
  }

  // Researcher: use Tavily in the background so the turn loop keeps going; report is applied when Tavily completes.
  // Only one research at a time — skip if a report is already in progress.
  if (agent.role === 'Researcher' && tavilyOk && !researcherTavilyInFlight) {
    if (turn.researchQuery && typeof turn.researchQuery === 'string') {
      const query = turn.researchQuery.trim().slice(0, 200)
      const researcherId = agent.id
      researcherTavilyInFlight = true
      applyAction({
        type: 'SAY',
        agentId: researcherId,
        text: `Researching "${query.slice(0, 50)}${query.length > 50 ? '…' : ''}" — gathering sources.`,
      })
      broadcastWorld()
      log('AGENT', 'Tavily research (background)', { agent: agent.name, query })
      const topicShort = query.slice(0, 36) + (query.length > 36 ? '…' : '')
      const progressTimeouts: ReturnType<typeof setTimeout>[] = []
      progressTimeouts.push(
        setTimeout(() => {
          applyAction({ type: 'SAY', agentId: researcherId, text: `Skimming sources on ${topicShort}.` })
          broadcastWorld()
        }, 8_000)
      )
      progressTimeouts.push(
        setTimeout(() => {
          applyAction({ type: 'SAY', agentId: researcherId, text: 'Pulling key points from a few more articles…' })
          broadcastWorld()
        }, 20_000)
      )
      progressTimeouts.push(
        setTimeout(() => {
          applyAction({ type: 'SAY', agentId: researcherId, text: 'Drafting the report…' })
          broadcastWorld()
        }, 35_000)
      )
      const clearProgress = () => {
        progressTimeouts.forEach((t) => clearTimeout(t))
        researcherTavilyInFlight = false
      }
      runTavilyResearch(query, { timeoutMs: 45_000 })
        .then((result) => {
          clearProgress()
          if (result?.summary != null) {
            const sources = (result.sources ?? []).slice(0, 5)
            const names = sources.map((s) => legibleSourceName(s.url, s.title))
            const bulletBreakdown =
              sources.length > 0
                ? sources
                    .map((s, i) => `• [${i + 1}] ${legibleSourceName(s.url, s.title)}${s.url ? ` (${s.url})` : ''}`)
                    .join('\n')
                : ''
            if (names.length > 0) {
              applyAction({ type: 'SAY', agentId: researcherId, text: `Sources: ${names.join(', ')}.` })
            }
            applyAction({
              type: 'CREATE_ARTIFACT',
              agentId: researcherId,
              artifactType: 'ResearchReport',
              title: `Research: ${query.slice(0, 60)}`,
              payload: {
                query,
                summary: result.summary.slice(0, 4000),
                sources: sources.map((s) => ({ title: s.title, url: s.url })),
                bulletBreakdown: bulletBreakdown || undefined,
              },
            })
            applyAction({ type: 'SET_INTENT', agentId: researcherId, intent: 'sit_in_chair' })
            broadcastWorld()
            log('AGENT', 'ResearchReport created (research)', { agent: agent.name, query, sources: sources.length })
          } else {
            log('AGENT', 'research returned no result', { agent: agent.name, query })
          }
        })
        .catch((err) => {
          clearProgress()
          log('AGENT', 'Tavily research error', { agent: agent.name, query, error: String(err) })
        })
    } else if (turn.extractUrls && Array.isArray(turn.extractUrls) && turn.extractUrls.length > 0) {
      const urls = turn.extractUrls.filter((u): u is string => typeof u === 'string' && u.startsWith('http')).slice(0, 5)
      if (urls.length > 0) {
        const researcherId = agent.id
        researcherTavilyInFlight = true
        const urlNames = urls.map((u) => legibleSourceName(u))
        applyAction({
          type: 'SAY',
          agentId: researcherId,
          text: `Extracting from ${urlNames.join(', ')}…`,
        })
        broadcastWorld()
        log('AGENT', 'Tavily extract (background)', { agent: agent.name, urlCount: urls.length })
        const progressT = setTimeout(() => {
          applyAction({ type: 'SAY', agentId: researcherId, text: 'Reading and summarizing pages…' })
          broadcastWorld()
        }, 6_000)
        runTavilyExtract(urls, { timeout: 15_000 })
          .then((result) => {
            clearTimeout(progressT)
            researcherTavilyInFlight = false
            if (result?.summary != null) {
              const byUrl = (result.byUrl ?? []).slice(0, 5)
              const bulletBreakdown =
                byUrl.length > 0
                  ? byUrl
                      .map((r, i) => `• [${i + 1}] ${legibleSourceName(r.url, r.title)}: ${(r.snippet ?? '').slice(0, 120)}…`)
                      .join('\n')
                  : ''
              const names = byUrl.map((r) => legibleSourceName(r.url, r.title))
              if (names.length > 0) {
                applyAction({ type: 'SAY', agentId: researcherId, text: `Sources: ${names.join(', ')}.` })
              }
              applyAction({
                type: 'CREATE_ARTIFACT',
                agentId: researcherId,
                artifactType: 'ResearchReport',
                title: `Extract: ${urls.length} URL(s)`,
                payload: {
                  query: 'extract',
                  summary: result.summary.slice(0, 4000),
                  sources: byUrl.map((r) => ({ title: r.title ?? undefined, url: r.url })),
                  bulletBreakdown: bulletBreakdown || undefined,
                },
              })
              applyAction({ type: 'SET_INTENT', agentId: researcherId, intent: 'sit_in_chair' })
              broadcastWorld()
              log('AGENT', 'ResearchReport created (extract)', { agent: agent.name, urlCount: urls.length })
            } else {
              log('AGENT', 'extract returned no result', { agent: agent.name })
            }
          })
          .catch((err) => {
            clearTimeout(progressT)
            researcherTavilyInFlight = false
            log('AGENT', 'Tavily extract error', { agent: agent.name, error: String(err) })
          })
      }
    } else if (turn.crawl?.url && typeof turn.crawl.url === 'string' && turn.crawl.url.startsWith('http')) {
      const url = turn.crawl.url.trim()
      const instructions = (typeof turn.crawl.instructions === 'string' && turn.crawl.instructions.trim()) || 'Summarize the main content and key points.'
      const crawlSiteName = legibleSourceName(url)
      const researcherId = agent.id
      researcherTavilyInFlight = true
      applyAction({
        type: 'SAY',
        agentId: researcherId,
        text: `Crawling ${crawlSiteName}… ${instructions.slice(0, 40)}${instructions.length > 40 ? '…' : ''}`,
      })
      broadcastWorld()
      log('AGENT', 'Tavily crawl (background)', { agent: agent.name, url })
      const progressT = setTimeout(() => {
        applyAction({ type: 'SAY', agentId: researcherId, text: `Following links on ${crawlSiteName}…` })
        broadcastWorld()
      }, 8_000)
      runTavilyCrawl(url, { instructions: instructions.slice(0, 300), timeout: 20_000 })
        .then((result) => {
          clearTimeout(progressT)
          researcherTavilyInFlight = false
          if (result?.summary != null) {
            const pages = (result.pages ?? []).slice(0, 5)
            const bulletBreakdown =
              pages.length > 0
                ? pages
                    .map((p, i) => `• [${i + 1}] ${legibleSourceName(p.url)}: ${(p.snippet ?? '').slice(0, 120)}…`)
                    .join('\n')
                : ''
            const names = pages.map((p) => legibleSourceName(p.url))
            if (names.length > 0) {
              applyAction({ type: 'SAY', agentId: researcherId, text: `Sources: ${names.join(', ')}.` })
            }
            applyAction({
              type: 'CREATE_ARTIFACT',
              agentId: researcherId,
              artifactType: 'ResearchReport',
              title: `Crawl: ${url.slice(0, 50)}`,
              payload: {
                query: 'crawl',
                summary: result.summary.slice(0, 4000),
                sources: pages.map((p) => ({ title: undefined, url: p.url })),
                bulletBreakdown: bulletBreakdown || undefined,
              },
            })
            applyAction({ type: 'SET_INTENT', agentId: researcherId, intent: 'sit_in_chair' })
            broadcastWorld()
            log('AGENT', 'ResearchReport created (crawl)', { agent: agent.name, url })
          } else {
            log('AGENT', 'crawl returned no result', { agent: agent.name, url })
          }
        })
        .catch((err) => {
          clearTimeout(progressT)
          researcherTavilyInFlight = false
          log('AGENT', 'Tavily crawl error', { agent: agent.name, url, error: String(err) })
        })
    }
  }

  // Architect/Builder: PixelLab pixel art (one request at a time)
  if (pixellabOk && pixellabRoleAllowed && !pixellabInFlight && hasPixellab()) {
    const hasCreateChar = turn.createCharacter?.description?.trim()
    const hasAnimate = turn.animateCharacter?.characterId?.trim()
    const hasTileset = turn.createTileset?.lower != null && turn.createTileset?.upper != null
    const hasIso = turn.createIsometricTile?.description?.trim()
    const count = (hasCreateChar ? 1 : 0) + (hasAnimate ? 1 : 0) + (hasTileset ? 1 : 0) + (hasIso ? 1 : 0)
    if (count === 1) {
      const agentId = agent.id
      pixellabInFlight = true
      const clearPixellab = () => {
        pixellabInFlight = false
        broadcastWorld()
      }
      if (hasCreateChar) {
        const desc = turn.createCharacter!.description.trim().slice(0, 300)
        applyAction({ type: 'SAY', agentId, text: `Requesting pixel art character: ${desc.slice(0, 50)}${desc.length > 50 ? '…' : ''}.` })
        broadcastWorld()
        log('AGENT', 'PixelLab createCharacter (background)', { agent: agent.name, description: desc.slice(0, 80) })
        runPixellabCreateCharacter(desc, turn.createCharacter!.n_directions ?? 8)
          .then((result) => {
            if (result?.error) {
              log('AGENT', 'PixelLab createCharacter error', { agent: agent.name, error: result.error })
              applyAction({ type: 'SAY', agentId, text: 'Pixel art request failed.' })
            } else if (result) {
              applyAction({
                type: 'CREATE_ARTIFACT',
                agentId,
                artifactType: 'PixelArt',
                title: `Character: ${desc.slice(0, 50)}`,
                payload: { tool: 'create_character', description: desc, characterId: result.characterId, urls: result.urls },
              })
              log('AGENT', 'PixelArt created (createCharacter)', { agent: agent.name })
            }
            clearPixellab()
          })
          .catch((err) => {
            log('AGENT', 'PixelLab createCharacter exception', { agent: agent.name, error: String(err) })
            clearPixellab()
          })
      } else if (hasAnimate) {
        const cid = turn.animateCharacter!.characterId.trim()
        const anim = turn.animateCharacter!.animation?.trim() || 'walk'
        applyAction({ type: 'SAY', agentId, text: `Requesting animation (${anim}) for character.` })
        broadcastWorld()
        log('AGENT', 'PixelLab animateCharacter (background)', { agent: agent.name, characterId: cid })
        runPixellabAnimateCharacter(cid, anim)
          .then((result) => {
            if (result?.error) {
              log('AGENT', 'PixelLab animateCharacter error', { agent: agent.name, error: result.error })
              applyAction({ type: 'SAY', agentId, text: 'Animation request failed.' })
            } else if (result) {
              applyAction({
                type: 'CREATE_ARTIFACT',
                agentId,
                artifactType: 'PixelArt',
                title: `Animation: ${anim}`,
                payload: { tool: 'animate_character', characterId: cid, animation: anim, urls: result.urls },
              })
              log('AGENT', 'PixelArt created (animateCharacter)', { agent: agent.name })
            }
            clearPixellab()
          })
          .catch((err) => {
            log('AGENT', 'PixelLab animateCharacter exception', { agent: agent.name, error: String(err) })
            clearPixellab()
          })
      } else if (hasTileset) {
        const lower = String(turn.createTileset!.lower).trim().slice(0, 100)
        const upper = String(turn.createTileset!.upper).trim().slice(0, 100)
        applyAction({ type: 'SAY', agentId, text: `Requesting tileset: ${lower} / ${upper}.` })
        broadcastWorld()
        log('AGENT', 'PixelLab createTileset (background)', { agent: agent.name, lower, upper })
        runPixellabCreateTileset(lower, upper)
          .then((result) => {
            if (result?.error) {
              log('AGENT', 'PixelLab createTileset error', { agent: agent.name, error: result.error })
              applyAction({ type: 'SAY', agentId, text: 'Tileset request failed.' })
            } else if (result) {
              applyAction({
                type: 'CREATE_ARTIFACT',
                agentId,
                artifactType: 'PixelArt',
                title: `Tileset: ${lower} / ${upper}`,
                payload: { tool: 'create_tileset', lower, upper, urls: result.urls },
              })
              log('AGENT', 'PixelArt created (createTileset)', { agent: agent.name })
            }
            clearPixellab()
          })
          .catch((err) => {
            log('AGENT', 'PixelLab createTileset exception', { agent: agent.name, error: String(err) })
            clearPixellab()
          })
      } else if (hasIso) {
        const desc = turn.createIsometricTile!.description.trim().slice(0, 300)
        const size = turn.createIsometricTile!.size ?? 32
        applyAction({ type: 'SAY', agentId, text: `Requesting isometric tile: ${desc.slice(0, 40)}…` })
        broadcastWorld()
        log('AGENT', 'PixelLab createIsometricTile (background)', { agent: agent.name, description: desc.slice(0, 80) })
        runPixellabCreateIsometricTile(desc, size)
          .then((result) => {
            if (result?.error) {
              log('AGENT', 'PixelLab createIsometricTile error', { agent: agent.name, error: result.error })
              applyAction({ type: 'SAY', agentId, text: 'Isometric tile request failed.' })
            } else if (result) {
              applyAction({
                type: 'CREATE_ARTIFACT',
                agentId,
                artifactType: 'PixelArt',
                title: `Isometric: ${desc.slice(0, 50)}`,
                payload: { tool: 'create_isometric_tile', description: desc, size, url: result.url, urls: result.url ? [result.url] : undefined },
              })
              log('AGENT', 'PixelArt created (createIsometricTile)', { agent: agent.name })
            }
            clearPixellab()
          })
          .catch((err) => {
            log('AGENT', 'PixelLab createIsometricTile exception', { agent: agent.name, error: String(err) })
            clearPixellab()
          })
      }
    }
  }

  if (turn.createArtifact?.artifactType && turn.createArtifact?.payload) {
    const artifactType = turn.createArtifact.artifactType
    if (['Proposal', 'ResearchReport', 'BuildSpec', 'DecisionRecord', 'StyleGuide', 'PixelArt'].includes(artifactType)) {
      if (artifactType === 'Proposal' && layoutSaturated && getFirstUnexecutedProposal(worldState) == null) {
        log('AGENT', 'proposal suppressed (layout saturated)', { agent: agent.name })
      } else {
      const payload = turn.createArtifact.payload as Record<string, unknown>
      let enginePayload: Record<string, unknown> = { ...payload }
      if (artifactType === 'Proposal') {
        const defId = payload.defId != null ? String(payload.defId).trim() : undefined
        const x = payload.x != null ? Number(payload.x) : NaN
        const yRaw = payload.y != null ? Number(payload.y) : NaN
        if (defId && !Number.isNaN(x) && !Number.isNaN(yRaw)) {
          enginePayload = { ...payload, defId: normalizeDefId(defId), x: Math.round(x), y: Math.round(yRaw) }
        }
      }
      const proposalValid = artifactType !== 'Proposal' || (enginePayload.defId != null && typeof enginePayload.x === 'number' && typeof enginePayload.y === 'number')
      if (proposalValid) {
        applyAction({
          type: 'CREATE_ARTIFACT',
          agentId: agent.id,
          artifactType: artifactType as 'Proposal' | 'ResearchReport' | 'BuildSpec' | 'DecisionRecord' | 'StyleGuide' | 'PixelArt',
          title: turn.createArtifact.title,
          payload: artifactType === 'Proposal' ? enginePayload : payload,
        })
        if (artifactType === 'Proposal') {
          lastProposalAddedTick = worldState.tick
          log('AGENT', 'createArtifact Proposal applied', { agent: agent.name, defId: enginePayload.defId, x: enginePayload.x, y: enginePayload.y })
        }
      }
      }
    }
  }

  // Architect can send the next proposal via nextProposal (so second item gets into queue without waiting for another turn)
  if (
    agent.role === 'Architect' &&
    turn.nextProposal?.defId != null &&
    turn.nextProposal?.x != null &&
    turn.nextProposal?.y != null &&
    getUnexecutedProposalCount(worldState) < 2 &&
    (!layoutSaturated || getFirstUnexecutedProposal(worldState) != null)
  ) {
    const payload: Record<string, unknown> = {
      defId: turn.nextProposal.defId,
      x: Math.round(turn.nextProposal.x),
      y: Math.round(turn.nextProposal.y),
    }
    if (turn.nextProposal.flipped !== undefined) payload.flipped = turn.nextProposal.flipped
    applyAction({
      type: 'CREATE_ARTIFACT',
      agentId: agent.id,
      artifactType: 'Proposal',
      title: undefined,
      payload,
    })
    lastProposalAddedTick = worldState.tick
    log('AGENT', 'nextProposal applied as Proposal', { agent: agent.name, defId: turn.nextProposal.defId })
  }

  if (turn.vote?.artifactId && turn.vote?.vote) {
    applyAction({
      type: 'VOTE',
      agentId: agent.id,
      artifactId: turn.vote.artifactId,
      vote: turn.vote.vote,
    })
  }

  // Only Builder may place. When queue has a proposal, Builder must place the first queue item exactly.
  // If queue is empty, Builder may directly decorate with wall pieces or floor.
  const queueHasProposal = getFirstUnexecutedProposal(worldState) != null
  const directDecorPlacement =
    agent.role === 'Builder' &&
    turn.placeItem?.defId != null &&
    (isStructuralWallPiece(normalizeDefId(turn.placeItem.defId)) || normalizeDefId(turn.placeItem.defId) === 'floor') &&
    !queueHasProposal
  if (
    agent.role === 'Builder' &&
    turn.placeItem?.defId != null &&
    turn.placeItem?.x != null &&
    turn.placeItem?.y != null &&
    (queueHasProposal || directDecorPlacement)
  ) {
    let placeX = turn.placeItem.x
    let placeY = turn.placeItem.y
    let defId = normalizeDefId(turn.placeItem.defId)
    if (agent.role === 'Builder' && builderMustPlace) {
      defId = builderMustPlace.defId
      placeX = builderMustPlace.x
      placeY = builderMustPlace.y
    }
    if (directDecorPlacement) {
      const validTiles = getValidPlacementTiles(worldState, defId)
      const requestedIsValid = validTiles.some((t) => t.x === placeX && t.y === placeY)
      if (!requestedIsValid && validTiles.length > 0) {
        const nextTile = validTiles.find((t) => t.x !== placeX || t.y !== placeY) ?? validTiles[0]!
        placeX = nextTile.x
        placeY = nextTile.y
        log('AGENT', 'direct decorate auto-advanced to next valid tile', {
          agent: agent.name,
          defId,
          requested: { x: turn.placeItem.x, y: turn.placeItem.y },
          using: { x: placeX, y: placeY },
        })
      }
    }
    const footprintCells = getPlacementFootprintCells(worldState, defId, placeX, placeY)
    if (moveBuilderOffFootprint(agent.id, footprintCells)) {
      log('AGENT', 'moved builder off placement footprint', { agent: agent.name, defId, placeX, placeY })
    }
    if (moveBlockingAgentsOffFootprint(agent.id, footprintCells)) {
      log('AGENT', 'moved blocking agents off placement footprint', { agent: agent.name, defId, placeX, placeY })
    }
    applyAction({
      type: 'PLACE_ITEM',
      agentId: agent.id,
      defId,
      x: placeX,
      y: placeY,
      flipped: turn.placeItem.flipped,
    })
    applyAction({ type: 'SET_INTENT', agentId: agent.id, intent: 'hold' })
  }

  if (turn.loadSkill?.trim()) {
    applyAction({
      type: 'LOAD_SKILL',
      agentId: agent.id,
      skillName: turn.loadSkill.trim(),
    })
  }

  worldState = updateScoresFromWorld(worldState)
  // Broadcast immediately so UI gets dialogue + placements in one update (avoids dialogue appearing ahead of grid)
  broadcastWorld()
}

/* -------------------------------------------------------------------------- */
/* LOOPS: sim/broadcast (fast) + agent dialogue (async, never blocks sim)      */
/* -------------------------------------------------------------------------- */

function startSimBroadcastLoop(): void {
  setInterval(() => {
    if (stopLoops) return
    broadcastWorld()
  }, SIM_BROADCAST_MS)
}

/**
 * Agent LLM turn scheduling (when and who).
 *
 * WHEN:
 * - Only one LLM runs at a time (llmInFlight). When a turn finishes we call setImmediate(tryStartAgentTurn), so the next turn starts as soon as the previous completes. Turn rate is effectively one per LLM response time.
 *
 * WHO (priority order):
 * 0. Researcher first-report — computer on site, zero ResearchReports yet → Nova goes to computer, sits, and generates first report.
 * 1. Round-robin (every N priority turns) — so Researcher gets to speak; otherwise starved by Builder/Architect.
 * 2. Builder — if there is a proposal in the build queue, and we haven't given Builder 10 turns in a row.
 * 3. Architect — if (a) queue is empty and we've given Architect fewer than 5 turns in a row, or (b) queue has room and ≥3 ticks since last proposal.
 * 4. Round-robin — agents[nextAgentTurnIndex % agents.length].
 */
function tryStartAgentTurn(): boolean {
  if (stopLoops || llmInFlight) return false
  const agents = worldState.agents
  if (agents.length === 0) return false
  const nowMs = Date.now()
  const hasPendingProposal = getFirstUnexecutedProposal(worldState) != null
  const layoutSaturatedNow = isLayoutSaturated(worldState)
  const tavilyAvailable =
    Boolean((process.env.TAVILY_API_KEY ?? '').trim()) &&
    (worldState.unlockedTech ?? []).includes('tavily_research')
  const researchReportCount = (worldState.artifacts ?? []).filter(
    (a: { type: string }) => a.type === 'ResearchReport'
  ).length
  const researcherFirstReportDue = tavilyAvailable && researchReportCount === 0
  const researcher = agents.find((a) => a.role === 'Researcher' && !isAgentRetryBlocked(a.id, nowMs))
  // After 402/429 we skip researcher-first for one turn so the chain doesn't stall on Nova; Builder/Architect get a turn
  const skipResearcherThisTurn = skipResearcherFirstReportNextTurn
  if (skipResearcherFirstReportNextTurn) skipResearcherFirstReportNextTurn = false
  if (!researcherFirstReportDue) researcherFirstReportStreak = 0
  const useResearcherFirstReport = Boolean(
    researcher &&
    researcherFirstReportDue &&
    !skipResearcherThisTurn &&
    researcherFirstReportStreak < RESEARCHER_FIRST_REPORT_STREAK_MAX
  )

  const prioritizedBuilder = hasPendingProposal ? agents.find((a) => a.role === 'Builder' && !isAgentRetryBlocked(a.id, nowMs)) : undefined
  const useBuilderPriority = Boolean(prioritizedBuilder) && builderPriorityStreak < 10
  const queueHasRoom = getUnexecutedProposalCount(worldState) < 2
  const ticksSinceLastProposal = worldState.tick - lastProposalAddedTick
  const proposalDue = !layoutSaturatedNow && queueHasRoom && ticksSinceLastProposal >= TICKS_BETWEEN_PROPOSALS
  const queueEmpty = !hasPendingProposal
  const architectForEmpty =
    queueEmpty && !layoutSaturatedNow && architectEmptyQueueStreak < ARCHITECT_EMPTY_QUEUE_STREAK_MAX
      ? agents.find((a) => a.role === 'Architect' && !isAgentRetryBlocked(a.id, nowMs))
      : undefined
  const architectForSchedule = proposalDue ? agents.find((a) => a.role === 'Architect' && !isAgentRetryBlocked(a.id, nowMs)) : undefined
  const prioritizedArchitect = architectForEmpty ?? architectForSchedule
  const useArchitectPriority = Boolean(prioritizedArchitect)
  const forceRoundRobin = priorityStreak >= PRIORITY_STREAK_BEFORE_ROUND_ROBIN

  const roundRobinPick = pickRoundRobinAgentAvoidBlocked(agents, nextAgentTurnIndex, nowMs)
  let agent = useResearcherFirstReport
    ? researcher!
    : forceRoundRobin
      ? roundRobinPick.agent
      : useBuilderPriority
        ? prioritizedBuilder!
        : useArchitectPriority
          ? prioritizedArchitect!
          : roundRobinPick.agent
  // Never schedule the same agent twice in a row when we have flexibility (avoids duplicate/echo dialogue).
  const canSkipSameAgent =
    lastTurnAgentId != null &&
    agent.id === lastTurnAgentId &&
    !useResearcherFirstReport &&
    !(useBuilderPriority && hasPendingProposal)
  if (canSkipSameAgent && agents.length > 1) {
    const idx = agents.findIndex((a) => a.id === agent.id)
    const nextIdx = pickRoundRobinIndexAvoidRepeat(agents, idx + 1, lastTurnAgentId)
    agent = agents[nextIdx]!
    nextAgentTurnIndex = nextIdx
    log('SCHEDULER', 'skip_same_agent', { was: lastTurnAgentId, now: agent.name })
  }
  const pickReason = useResearcherFirstReport
    ? 'researcher_first_report'
    : forceRoundRobin
      ? 'round_robin'
      : useBuilderPriority
        ? 'builder_priority'
        : useArchitectPriority
          ? architectForEmpty
            ? 'architect_empty_queue'
            : 'architect_proposal_due'
          : 'round_robin'
  log('SCHEDULER', 'pick', { agent: agent.name, role: agent.role, reason: pickReason, tick: worldState.tick })

  const runTurn = (): Promise<void> => {
    const firstUnexecuted = getFirstUnexecutedProposal(worldState)
    const queueIsDirectDecor = (() => {
      const p = firstUnexecuted?.payload as { defId?: string } | undefined
      return p?.defId != null && isDirectDecorDefId(String(p.defId))
    })()
    if (agent.role === 'Builder' && useBuilderPriority && SKIP_LLM_FOR_BUILDER_PLACEMENT && llmEnabled && !queueIsDirectDecor) {
      return runBuilderPlacementOnly(agent)
    }
    if (agent.role === 'Architect' && useArchitectPriority && getUnexecutedProposalCount(worldState) < 2 && SKIP_LLM_FOR_ARCHITECT_PROPOSAL && llmEnabled && getNextProposalFromWorld(worldState) != null) {
      return runArchitectProposalOnly(agent)
    }
    return runAgentTurn(agent)
  }

  llmInFlight = true
  llmInFlightStartedAt = Date.now()
  runTurn()
    .then(() => {
      lastTurnAgentId = agent.id
      if (useResearcherFirstReport) {
        researcherFirstReportStreak++
        nextAgentTurnIndex++
        builderPriorityStreak = 0
        architectEmptyQueueStreak = 0
        priorityStreak = 0
      } else if (forceRoundRobin) {
        researcherFirstReportStreak = 0
        nextAgentTurnIndex++
        builderPriorityStreak = 0
        architectEmptyQueueStreak = 0
        priorityStreak = 0
      } else if (useBuilderPriority) {
        researcherFirstReportStreak = 0
        builderPriorityStreak++
        architectEmptyQueueStreak = 0
        priorityStreak++
      } else if (useArchitectPriority) {
        researcherFirstReportStreak = 0
        architectEmptyQueueStreak++
        nextAgentTurnIndex = (agents.findIndex((a) => a.id === agent.id) + 1) % agents.length
        priorityStreak++
      } else {
        researcherFirstReportStreak = 0
        nextAgentTurnIndex++
        builderPriorityStreak = 0
        architectEmptyQueueStreak = 0
        priorityStreak = 0
      }
      if (!getFirstUnexecutedProposal(worldState)) builderPriorityStreak = 0
      if (getFirstUnexecutedProposal(worldState) != null) architectEmptyQueueStreak = 0
      llmInFlight = false
      consecutiveRetryableTurnErrors = 0
      markTurnCompleted()
      scheduleNextAgentTurn(MIN_AGENT_TURN_GAP_MS)
    })
    .catch((err) => {
      const status = (err as Error & { status?: number }).status
      const retryable =
        status === 402 || status === 400 || status === 429 || (typeof status === 'number' && status >= 500 && status < 600)
      log('ERROR', 'agent turn scheduler', { agent: agent.name, error: String(err), retryable: retryable ? 'skip researcher next turn' : undefined })
      // So we don't stall on Nova when 402/429: skip researcher-first for one turn so Builder/Architect can run
      if (retryable && agent.role === 'Researcher') skipResearcherFirstReportNextTurn = true
      if (retryable) {
        // Architect/Builder can continue the core build pipeline through no-LLM fast paths.
        // Long cooldowns on these roles can pause chair/computer slot completion when queue is empty.
        const shouldCooldownAgent = !(
          (agent.role === 'Builder' && SKIP_LLM_FOR_BUILDER_PLACEMENT) ||
          (agent.role === 'Architect' && SKIP_LLM_FOR_ARCHITECT_PROPOSAL)
        )
        if (shouldCooldownAgent) {
          retryBlockedUntilByAgent.set(agent.id, Date.now() + AGENT_RETRY_COOLDOWN_MS)
        }
        // Advance turn index away from the failing agent so round-robin can keep sim moving.
        const failedIdx = agents.findIndex((a) => a.id === agent.id)
        if (failedIdx >= 0) nextAgentTurnIndex = (failedIdx + 1) % agents.length
        priorityStreak = 0
        consecutiveRetryableTurnErrors++
      } else {
        consecutiveRetryableTurnErrors = 0
      }
      llmInFlight = false
      markTurnCompleted()
      const backoffFactor = Math.min(4, Math.max(1, 2 ** Math.max(0, consecutiveRetryableTurnErrors - 1)))
      const backoffMs = retryable ? RETRYABLE_TURN_BACKOFF_MS * backoffFactor : MIN_AGENT_TURN_GAP_MS
      scheduleNextAgentTurn(Math.max(MIN_AGENT_TURN_GAP_MS, backoffMs))
    })
  return true
}

function startAgentTurnScheduler(): void {
  scheduleNextAgentTurn(0)
}

function startLivenessWatchdog(): void {
  setInterval(() => {
    if (stopLoops) return
    const now = Date.now()
    if (llmInFlight && llmInFlightStartedAt > 0 && now - llmInFlightStartedAt > LLM_TURN_TIMEOUT_MS) {
      log('WARN', 'llm turn timeout; recovering scheduler', {
        timeoutMs: LLM_TURN_TIMEOUT_MS,
        inFlightForMs: now - llmInFlightStartedAt,
      })
      llmInFlight = false
      markTurnCompleted()
      setImmediate(() => tryStartAgentTurn())
      return
    }
    if (!llmInFlight && now - lastTurnCompletedAt > LOOP_STALL_WARN_MS) {
      log('WARN', 'turn loop stalled; nudging scheduler', {
        stalledForMs: now - lastTurnCompletedAt,
      })
      setImmediate(() => tryStartAgentTurn())
    }
  }, 5_000)
}

function startMemoryMonitor(): void {
  // Prime baseline immediately, then keep watching for sustained growth.
  recordMemorySampleAndMaybeWarn()
  setInterval(() => {
    if (stopLoops) return
    recordMemorySampleAndMaybeWarn()
  }, MEMORY_MONITOR_MS)
}

/* -------------------------------------------------------------------------- */
/* SERVER                                                                     */
/* -------------------------------------------------------------------------- */

function serializeArtifactsForClient(artifacts: WorldState['artifacts']): WorldState['artifacts'] {
  const recent = (artifacts ?? []).slice(-180)
  return recent.map((a) => {
    if (a.type === 'Proposal') {
      const p = (a.payload ?? {}) as { defId?: unknown; x?: unknown; y?: unknown }
      return {
        ...a,
        payload: { defId: p.defId, x: p.x, y: p.y },
      }
    }
    // Keep non-proposal artifacts lightweight for UI to avoid large websocket payloads.
    return {
      ...a,
      payload: {},
    }
  })
}

function worldPayload(): Record<string, unknown> {
  const withPos = applyEphemeralAgentPositions(worldState)
  return {
    type: 'world',
    world: {
      ...withPos,
      artifacts: serializeArtifactsForClient(withPos.artifacts),
      chatLog: withPos.chatLog ?? [],
      lastEvents: withPos.lastEvents ?? [],
      artifactVotes: withPos.artifactVotes ?? {},
      executedProposalIds: withPos.executedProposalIds ?? [],
      mode: llmEnabled ? 'llm' : 'stub',
      modeNote: llmEnabled ? undefined : 'LLM off — debug mode (no credits).',
    },
  }
}

function broadcastWorld(): void {
  const now = Date.now()
  if (!worldDirtyForBroadcast && now - lastBroadcastAtMs < FORCE_BROADCAST_MS) return
  broadcastCount++
  try {
    const msg = JSON.stringify(worldPayload())
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg)
    })
    lastBroadcastAtMs = now
    worldDirtyForBroadcast = false
  } catch (_) {}
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url.pathname === '/world' || url.pathname === '/api/world') {
    res.setHeader('Content-Type', 'application/json')
    const withPos = applyEphemeralAgentPositions(worldState)
    res.end(
      JSON.stringify({
        ...withPos,
        artifacts: serializeArtifactsForClient(withPos.artifacts),
        chatLog: withPos.chatLog ?? [],
        lastEvents: withPos.lastEvents ?? [],
        artifactVotes: withPos.artifactVotes ?? {},
        executedProposalIds: withPos.executedProposalIds ?? [],
        mode: llmEnabled ? 'llm' : 'stub',
        modeNote: llmEnabled ? undefined : 'LLM off — debug mode (no credits).',
      })
    )
    return
  }

  if ((url.pathname === '/api/llm-toggle' || url.pathname === '/llm-toggle') && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {}
        if (typeof parsed.enabled === 'boolean') {
          llmEnabled = parsed.enabled
          log('HTTP', 'llm-toggle', { enabled: llmEnabled })
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ enabled: llmEnabled }))
      } catch (e) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid JSON or missing enabled' }))
      }
    })
    return
  }

  if ((url.pathname === '/api/llm-toggle' || url.pathname === '/llm-toggle') && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ enabled: llmEnabled }))
    return
  }

  if (url.pathname === '/health') {
    res.setHeader('Content-Type', 'application/json')
    const stats = getRuntimeStats()
    const memory = (stats.memory ?? {}) as Record<string, unknown>
    res.end(JSON.stringify({ ok: true, tick: worldState.tick, heapUsedMb: memory.heapUsedMb, rssMb: memory.rssMb }))
    return
  }

  if (url.pathname === '/api/runtime-stats' || url.pathname === '/runtime-stats') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(getRuntimeStats()))
    return
  }

  if (url.pathname === '/api/logs' || url.pathname === '/logs') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(getLogDump())
    return
  }

  if ((url.pathname === '/api/human-place' || url.pathname === '/human-place') && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      try {
        const parsed = body ? JSON.parse(body) : {}
        const defId = typeof parsed.defId === 'string' ? parsed.defId : undefined
        const x = typeof parsed.x === 'number' ? parsed.x : undefined
        const y = typeof parsed.y === 'number' ? parsed.y : undefined
        const flipped = typeof parsed.flipped === 'boolean' ? parsed.flipped : undefined
        if (defId == null || x == null || y == null) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing defId, x, or y' }))
          return
        }
        // Floor = paint one cell with main office floor slice (no item placed)
        const action: Action = defId === 'floor'
          ? { type: 'HUMAN_PAINT_FLOOR_SLICE', x, y }
          : { type: 'HUMAN_PLACE_ITEM', defId, x, y }
        if (action.type === 'HUMAN_PLACE_ITEM' && flipped !== undefined) action.flipped = flipped
        const { state: next, event } = reduce(worldState, action, eventIndexThisTick)
        const isFail = event.action.type === 'FAIL_ACTION'
        if (isFail) {
          const reason = (event.action as { reason?: string }).reason ?? 'Placement failed'
          log('HTTP', 'human-place failed', { defId, x, y, reason })
          res.writeHead(400)
          res.end(JSON.stringify({ error: reason }))
          return
        }
        worldState = next
        worldDirtyForBroadcast = true
        appendEvent(worldState.tick, eventIndexThisTick, event.action as Action)
        eventIndexThisTick++
        worldState = updateScoresFromWorld(worldState)
        broadcastWorld()
        log('HTTP', 'human-place ok', { defId, x, y })
        res.end(
          JSON.stringify({
            ...worldState,
            chatLog: worldState.chatLog ?? [],
            lastEvents: worldState.lastEvents ?? [],
            artifactVotes: worldState.artifactVotes ?? {},
            executedProposalIds: worldState.executedProposalIds ?? [],
            mode: llmEnabled ? 'llm' : 'stub',
            modeNote: llmEnabled ? undefined : 'LLM off — debug mode (no credits).',
          })
        )
      } catch (e) {
        log('ERROR', 'human-place', { error: String(e) })
        res.writeHead(400)
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if ((url.pathname === '/api/human-remove' || url.pathname === '/human-remove') && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      try {
        const parsed = body ? JSON.parse(body) : {}
        const x = typeof parsed.x === 'number' ? parsed.x : undefined
        const y = typeof parsed.y === 'number' ? parsed.y : undefined
        if (x == null || y == null) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing x or y' }))
          return
        }
        const action = { type: 'HUMAN_REMOVE_ITEM' as const, x, y }
        const { state: next, event } = reduce(worldState, action, eventIndexThisTick)
        const isFail = event.action.type === 'FAIL_ACTION'
        if (isFail) {
          const reason = (event.action as { reason?: string }).reason ?? 'Remove failed'
          log('HTTP', 'human-remove failed', { x, y, reason })
          res.writeHead(400)
          res.end(JSON.stringify({ error: reason }))
          return
        }
        worldState = next
        worldDirtyForBroadcast = true
        appendEvent(worldState.tick, eventIndexThisTick, event.action as Action)
        eventIndexThisTick++
        worldState = updateScoresFromWorld(worldState)
        broadcastWorld()
        log('HTTP', 'human-remove ok', { x, y })
        res.end(
          JSON.stringify({
            ...worldState,
            chatLog: worldState.chatLog ?? [],
            lastEvents: worldState.lastEvents ?? [],
            artifactVotes: worldState.artifactVotes ?? {},
            executedProposalIds: worldState.executedProposalIds ?? [],
            mode: llmEnabled ? 'llm' : 'stub',
            modeNote: llmEnabled ? undefined : 'LLM off — debug mode (no credits).',
          })
        )
      } catch (e) {
        log('ERROR', 'human-remove', { error: String(e) })
        res.writeHead(400)
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if ((url.pathname === '/nuke' || url.pathname === '/api/nuke') && req.method === 'POST') {
    try {
      clearAllEvents()
      clearLogBuffer()
      worldState = createInitialWorldState({ spawnSeed: Date.now() })
      worldDirtyForBroadcast = true
      eventIndexThisTick = 0
      lastTurnAgentId = null
      nextAgentTurnIndex = 0
      builderPriorityStreak = 0
      architectEmptyQueueStreak = 0
      priorityStreak = 0
      lastProposalAddedTick = 0
      log('STATE', 'nuke: world reset (random spawn positions, scheduler reset)')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      broadcastWorld()
    } catch (e) {
      log('ERROR', 'nuke failed', { error: String(e) })
      res.writeHead(500)
      res.end(JSON.stringify({ ok: false, error: String(e) }))
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data))
      if (msg?.type === 'pos' && typeof msg.agentId === 'string' && typeof msg.x === 'number' && typeof msg.y === 'number') {
        noteAgentPos(msg.agentId, msg.x, msg.y)
      }
    } catch {}
  })
  broadcastWorld()
})

server.listen(PORT, '0.0.0.0', () => {
  loadState()
  broadcastWorld()

  // Movement is client-only (UI pathfinding). Server does not run movement loop or persist MOVE_AGENT.
  startSimBroadcastLoop()
  startAgentTurnScheduler()
  startLivenessWatchdog()
  startMemoryMonitor()

  log('HTTP', 'runtime ready', {
    port: PORT,
    simBroadcastMs: SIM_BROADCAST_MS,
    world: '/world',
    logs: '/api/logs',
  })
})

/* -------------------------------------------------------------------------- */
/* SHUTDOWN                                                                   */
/* -------------------------------------------------------------------------- */

process.on('SIGINT', () => {
  stopLoops = true
  if (turnScheduleTimer) {
    clearTimeout(turnScheduleTimer)
    turnScheduleTimer = null
  }
  closeDb()
  process.exit(0)
})