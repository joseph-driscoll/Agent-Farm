/**
 * Deterministic reducer: WorldState + Action → New WorldState.
 * All world changes go through here. No side effects.
 */

import type { WorldState, Action, Event, Artifact, PlacedItem, ChatEntry, MemoryEntry } from './schemas.js'
import { ActionSchema } from './schemas.js'
import {
  getItemDef,
  getPlacedItemsAt,
  getBlockingItemsAt,
  canPlaceAt,
  getPlacementFailureReason,
  getAgent,
  getCell,
  BACK_WALL_ROWS,
  getComputerFlipped,
  getChairFlipped,
  getWorkstationAt,
  hasChairOnRightOfDesk,
  normalizeDefId,
  AGENT_IN_THE_WAY_REASON,
  isCellBlockedForAgents,
  isStructuralWallPiece,
} from './worldState.js'

const MAX_LAST_EVENTS = 200
const MAX_CHAT_LOG = 200
/** Cap per-agent memory; evict by (importance desc, tick desc) so high-value + recent stay. */
export const MAX_MEMORY_PER_AGENT = 50
const MAX_ARTIFACTS = 300
const MAX_PROPOSAL_ID_HISTORY = 600

/** Deterministic ID so replay produces same IDs and votes/placements line up. */
function nextId(prefix: string, tick: number, eventIndex: number): string {
  return `${prefix}-${tick}-${eventIndex}`
}

function pushLastEvent(state: WorldState, event: Event): WorldState {
  const lastEvents = [...(state.lastEvents ?? []), event].slice(-MAX_LAST_EVENTS)
  return { ...state, lastEvents }
}

/** If agent missing, returns fail action to record; otherwise returns the agent. */
function requireAgent(state: WorldState, action: Action): { agent: NonNullable<ReturnType<typeof getAgent>> } | { fail: Action } {
  const agentId = 'agentId' in action ? action.agentId : 'unknown'
  const agent = getAgent(state, agentId)
  if (!agent) return { fail: { type: 'FAIL_ACTION', agentId, reason: 'Unknown agent', attemptedAction: action } }
  return { agent }
}

function failAndPush(state: WorldState, event: Event, fail: Action): { state: WorldState; event: Event } {
  return { state: pushLastEvent(state, { ...event, action: fail }), event }
}

export const MAX_PROPOSALS_IN_QUEUE = 2

/** First Proposal not yet executed or rejected (build queue — no voting). Builder must place this one next. Skips paint proposals (no paint palette). */
export function getFirstUnexecutedProposal(state: WorldState): Artifact | null {
  const executed = state.executedProposalIds ?? []
  const rejected = state.rejectedProposalIds ?? []
  for (const art of state.artifacts) {
    if (art.type !== 'Proposal' || executed.includes(art.id) || rejected.includes(art.id)) continue
    const p = art.payload as { action?: string }
    if (p?.action === 'paint_floor' || p?.action === 'paint_wall') continue
    return art
  }
  return null
}

/** Count of proposals not yet built (excluding rejected). Architect may add when this is < MAX_PROPOSALS_IN_QUEUE. */
export function getUnexecutedProposalCount(state: WorldState): number {
  const executed = state.executedProposalIds ?? []
  const rejected = state.rejectedProposalIds ?? []
  return state.artifacts.filter(
    (a) => a.type === 'Proposal' && !executed.includes(a.id) && !rejected.includes(a.id)
  ).length
}

/** Proposal matching (defId, x, y) that is the first unexecuted one (so Builder can place it). Placement allowed when this returns non-null. DefIds are normalized so e.g. office_atlas.json#workstation_01 matches workstation. */
export function findApprovedProposalForPlacement(
  state: WorldState,
  defId: string,
  x: number,
  y: number
): Artifact | null {
  const first = getFirstUnexecutedProposal(state)
  if (!first) return null
  const p = first.payload as { defId?: string; x?: number; y?: number }
  const ax = Number(x)
  const ay = Number(y)
  const normDefId = normalizeDefId(defId)
  const normPDefId = normalizeDefId(p?.defId ?? '')
  if (normPDefId !== normDefId) return null
  if (Number(p?.x) === ax && Number(p?.y) === ay) return first
  // Computer: allow proposal at desk center (x+2) to match placement at correct inward cell (x+1 or x+3)
  if (normDefId === 'computer' && normPDefId === 'computer') {
    const px = Number(p?.x)
    const py = Number(p?.y)
    const desk = getWorkstationAt(state, px, py)
    if (desk && py === desk.y + 1 && px === desk.x + 2) {
      if ((ax === desk.x + 1 || ax === desk.x + 3) && ay === desk.y + 1) return first
    }
  }
  return null
}

function applyHumanPaintFloorSlice(
  state: WorldState,
  action: Extract<Action, { type: 'HUMAN_PAINT_FLOOR_SLICE' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const cell = getCell(state, action.x, action.y)
  if (!cell) return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: 'human', reason: 'Out of bounds', attemptedAction: action })
  if (cell.kind !== 'floor') return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: 'human', reason: 'Can only paint floor on floor cells', attemptedAction: action })
  const cells = state.cells.map((c) =>
    c.x === action.x && c.y === action.y ? { ...c, floorFromSlice: true } : c
  )
  const next: WorldState = { ...state, cells }
  return { state: pushLastEvent(next, event), event }
}

function applyHumanPlaceItem(
  state: WorldState,
  action: Extract<Action, { type: 'HUMAN_PLACE_ITEM' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const defId = normalizeDefId(action.defId)
  let placeX = action.x
  let placeY = action.y
  if (defId === 'computer') {
    const desk = getWorkstationAt(state, action.x, action.y)
    if (desk && action.y === desk.y + 1 && action.x === desk.x + 2) {
      placeX = hasChairOnRightOfDesk(state, action.x, action.y) ? desk.x + 3 : desk.x + 1
      placeY = action.y
    }
  }
  if (!canPlaceAt(state, defId, placeX, placeY, { allowPerimeterWallTop: true })) {
    const reason = getPlacementFailureReason(state, defId, placeX, placeY) || 'Cannot place: invalid position'
    return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: 'human', reason, attemptedAction: action })
  }
  const def = getItemDef(state, defId)
  if (!def) return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: 'human', reason: 'Unknown item def', attemptedAction: action })
  let flipped = action.flipped
  if (flipped === undefined && defId === 'computer') flipped = getComputerFlipped(state, placeX, placeY)
  if (flipped === undefined && defId === 'chair') flipped = getChairFlipped(state, placeX, placeY)
  const unlockedTech = [...state.unlockedTech]
  for (const effect of def.unlockEffects ?? []) {
    if (!unlockedTech.includes(effect)) unlockedTech.push(effect)
  }
  const newItem: PlacedItem = {
    id: nextId('item', state.tick, eventIndex),
    defId: def.id,
    x: placeX,
    y: placeY,
    placedAtTick: state.tick,
    flipped: flipped ?? false,
  }
  const next: WorldState = {
    ...state,
    items: [...state.items, newItem],
    unlockedTech,
    scores: { ...state.scores, aesthetic: state.scores.aesthetic + def.aestheticValue, power: state.scores.power + def.powerValue },
  }
  return { state: pushLastEvent(next, event), event }
}

/** Chair and computer positions that belong to a workstation at (wx, wy). Footprint 5×2; desk row is wy+1; chair slots (wx, wy+1), (wx+4, wy+1); computer slots (wx+1, wy+1), (wx+3, wy+1). */
function getWorkstationDependentSlots(wx: number, wy: number): Array<[number, number]> {
  const deskY = wy + 1
  return [
    [wx, deskY],
    [wx + 1, deskY],
    [wx + 3, deskY],
    [wx + 4, deskY],
  ]
}

function applyHumanRemoveItem(
  state: WorldState,
  action: Extract<Action, { type: 'HUMAN_REMOVE_ITEM' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const at = getPlacedItemsAt(state, action.x, action.y)
  if (at.length === 0) {
    return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: 'human', reason: 'No object at this cell', attemptedAction: action })
  }
  // Prefer removing a blocking item (floor/wall don't occupy cells); otherwise remove last at cell
  const blocking = getBlockingItemsAt(state, action.x, action.y)
  const toRemove = (blocking.length > 0 ? blocking[blocking.length - 1] : at[at.length - 1])!
  let idsToRemove = new Set<string>([toRemove.id])
  // When removing a workstation, cascade-delete its chairs and computers so user doesn't have to remove them first
  if (toRemove.defId === 'workstation') {
    const slots = getWorkstationDependentSlots(toRemove.x, toRemove.y)
    for (const [sx, sy] of slots) {
      for (const item of state.items) {
        if ((item.defId === 'chair' || item.defId === 'computer') && item.x === sx && item.y === sy) {
          idsToRemove.add(item.id)
        }
      }
    }
  }
  let aestheticDelta = 0
  let powerDelta = 0
  for (const item of state.items) {
    if (!idsToRemove.has(item.id)) continue
    const def = getItemDef(state, item.defId)
    aestheticDelta += def?.aestheticValue ?? 0
    powerDelta += def?.powerValue ?? 0
  }
  const next: WorldState = {
    ...state,
    items: state.items.filter((item) => !idsToRemove.has(item.id)),
    scores: {
      ...state.scores,
      aesthetic: Math.max(0, state.scores.aesthetic - aestheticDelta),
      power: Math.max(0, state.scores.power - powerDelta),
    },
  }
  return { state: pushLastEvent(next, event), event }
}

function applyPlaceItem(
  state: WorldState,
  action: Extract<Action, { type: 'PLACE_ITEM' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const defId = normalizeDefId(action.defId)
  let placeX = action.x
  let placeY = action.y
  // Snap computer from invalid center cell (desk.x+2) to correct inward cell (desk.x+1 or desk.x+3)
  if (defId === 'computer') {
    const desk = getWorkstationAt(state, action.x, action.y)
    if (desk && action.y === desk.y + 1 && action.x === desk.x + 2) {
      placeX = hasChairOnRightOfDesk(state, action.x, action.y) ? desk.x + 3 : desk.x + 1
      placeY = action.y
    }
  }

  const canDirectDecorate = req.agent.role === 'Builder' && (isStructuralWallPiece(defId) || defId === 'floor')
  const allowBuilderUngatedPlacement = req.agent.role === 'Builder'
  const approved = findApprovedProposalForPlacement(state, defId, placeX, placeY)
  if (!approved && !canDirectDecorate && !allowBuilderUngatedPlacement) {
    const first = getFirstUnexecutedProposal(state)
    const hint = first
      ? (() => {
          const p = first.payload as { defId?: string; x?: number; y?: number }
          const dx = p?.x ?? '?'
          const dy = p?.y ?? '?'
          return `First in queue is ${p?.defId ?? '?'} at (${dx},${dy}). Place that exact item at those coordinates, or paint floor or place wall pieces directly.`
        })()
      : 'Build queue is empty — wait for a new proposal.'
    return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: action.agentId, reason: `No matching proposal in the build queue for this placement — ${hint}`, attemptedAction: action })
  }

  const isPerimeterWallPiece =
    isStructuralWallPiece(defId) &&
    placeY >= BACK_WALL_ROWS &&
    (placeX === 0 || placeX === state.gridWidth - 1 || placeY === state.gridHeight - 1)
  if (!canPlaceAt(state, defId, placeX, placeY, isPerimeterWallPiece ? { allowPerimeterWallTop: true } : undefined)) {
    const reason = getPlacementFailureReason(state, defId, placeX, placeY) || 'Cannot place: invalid position'
    // When an agent is in the way, do NOT reject the proposal — retry until the spot is clear
    if (reason === AGENT_IN_THE_WAY_REASON) {
      return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: action.agentId, reason, attemptedAction: action })
    }
    // "Already placed at (x,y)" means the desired state is done — mark as executed so queue advances and Builder gets next task.
    const alreadyPlacedMatch = approved && /^Already placed .+ at \(\d+,\d+\)/.test(reason)
    if (approved) {
      const nextState: WorldState = alreadyPlacedMatch
        ? {
            ...state,
            executedProposalIds: [...(state.executedProposalIds ?? []), approved.id].slice(-MAX_PROPOSAL_ID_HISTORY),
          }
        : {
            ...state,
            rejectedProposalIds: [...(state.rejectedProposalIds ?? []), approved.id].slice(-MAX_PROPOSAL_ID_HISTORY),
          }
      return failAndPush(nextState, event, { type: 'FAIL_ACTION', agentId: action.agentId, reason, attemptedAction: action })
    }
    return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: action.agentId, reason, attemptedAction: action })
  }

  const def = getItemDef(state, defId)
  if (!def) return failAndPush(state, event, { type: 'FAIL_ACTION', agentId: action.agentId, reason: 'Unknown item def', attemptedAction: action })

  let flipped = action.flipped
  if (flipped === undefined && defId === 'computer') flipped = getComputerFlipped(state, placeX, placeY)
  if (flipped === undefined && defId === 'chair') flipped = getChairFlipped(state, placeX, placeY)

  const unlockedTech = [...state.unlockedTech]
  for (const effect of def.unlockEffects ?? []) {
    if (!unlockedTech.includes(effect)) unlockedTech.push(effect)
  }

  const newItem: PlacedItem = {
    id: nextId('item', state.tick, eventIndex),
    defId,
    x: placeX,
    y: placeY,
    placedAtTick: state.tick,
    flipped: flipped ?? false,
  }
  const next: WorldState = {
    ...state,
    items: [...state.items, newItem],
    unlockedTech,
    executedProposalIds: approved
      ? [...(state.executedProposalIds ?? []), approved.id].slice(-MAX_PROPOSAL_ID_HISTORY)
      : (state.executedProposalIds ?? []).slice(-MAX_PROPOSAL_ID_HISTORY),
    scores: { ...state.scores, aesthetic: state.scores.aesthetic + def.aestheticValue, power: state.scores.power + def.powerValue },
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, lastActionAtTick: state.tick, currentIntent: 'hold' } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyExpandGrid(
  state: WorldState,
  action: Extract<Action, { type: 'EXPAND_GRID' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const amount = action.amount ?? 1
  let gridWidth = state.gridWidth
  let gridHeight = state.gridHeight
  let newCells = state.cells.map((c) => ({ ...c }))

  if (action.direction === 'e') {
    for (let y = 0; y < gridHeight; y++) {
      for (let i = 0; i < amount; i++) {
        const x = gridWidth + i
        const kind = y < BACK_WALL_ROWS ? 'wall' : 'floor'
        newCells.push({ x, y, kind, roomId: 'main' })
      }
    }
    gridWidth += amount
  } else if (action.direction === 'w') {
    newCells = newCells.map((c) => ({ ...c, x: c.x + amount }))
    for (let y = 0; y < gridHeight; y++) {
      for (let i = 0; i < amount; i++) {
        newCells.push({ x: i, y, kind: y < BACK_WALL_ROWS ? 'wall' : 'floor', roomId: 'main' })
      }
    }
    gridWidth += amount
  } else if (action.direction === 's') {
    for (let x = 0; x < gridWidth; x++) {
      for (let i = 0; i < amount; i++) {
        const y = gridHeight + i
        newCells.push({ x, y, kind: 'floor', roomId: 'main' })
      }
    }
    gridHeight += amount
  } else if (action.direction === 'n') {
    // North expansion disabled: back wall (top 3 rows) stays fixed; only floor expands south/east/west
  }

  let items = state.items
  let agents = state.agents
  if (action.direction === 'w') {
    items = state.items.map((it) => ({ ...it, x: it.x + amount }))
    agents = state.agents.map((a) => ({ ...a, x: a.x + amount }))
  }
  // North expansion is no-op: back wall stays fixed at top
  const next: WorldState = {
    ...state,
    gridWidth,
    gridHeight,
    cells: newCells,
    items,
    agents: agents.map((a) =>
      a.id === action.agentId ? { ...a, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyCreateArtifact(
  state: WorldState,
  action: Extract<Action, { type: 'CREATE_ARTIFACT' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  if (action.artifactType === 'Proposal' && getUnexecutedProposalCount(state) >= MAX_PROPOSALS_IN_QUEUE) {
    return failAndPush(state, event, {
      type: 'FAIL_ACTION',
      agentId: action.agentId,
      reason: `Build queue is full (max ${MAX_PROPOSALS_IN_QUEUE}); wait for Builder to place one before adding another proposal.`,
      attemptedAction: action,
    })
  }

  const payload = action.payload as { action?: string }
  if (action.artifactType === 'Proposal' && (payload?.action === 'paint_floor' || payload?.action === 'paint_wall')) {
    return failAndPush(state, event, {
      type: 'FAIL_ACTION',
      agentId: action.agentId,
      reason: 'Paint proposals are not supported; use defId, x, y from Good next spots only.',
      attemptedAction: action,
    })
  }

  const artifact: Artifact = {
    id: nextId('art', state.tick, eventIndex),
    type: action.artifactType,
    authorAgentId: action.agentId,
    createdAtTick: state.tick,
    title: action.title,
    payload: action.payload,
    refs: action.refs,
  }
  const artifacts = [...state.artifacts, artifact].slice(-MAX_ARTIFACTS)
  const artifactIds = new Set(artifacts.map((a) => a.id))
  const artifactVotes = Object.fromEntries(
    Object.entries(state.artifactVotes ?? {}).filter(([artifactId]) => artifactIds.has(artifactId))
  ) as Record<string, Record<string, 'yes' | 'no'>>
  const executedProposalIds = (state.executedProposalIds ?? []).filter((id) => artifactIds.has(id)).slice(-MAX_PROPOSAL_ID_HISTORY)
  const rejectedProposalIds = (state.rejectedProposalIds ?? []).filter((id) => artifactIds.has(id)).slice(-MAX_PROPOSAL_ID_HISTORY)
  const collaboration = state.scores.collaboration + 1
  const next: WorldState = {
    ...state,
    artifacts,
    artifactVotes,
    executedProposalIds,
    rejectedProposalIds,
    scores: { ...state.scores, collaboration },
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyCollaboration(
  state: WorldState,
  action: Extract<Action, { type: 'ASK_AGENT' | 'RESPOND_AGENT' | 'REQUEST_REVIEW' | 'REVIEW_RESULT' | 'DELEGATE_TASK' | 'COMMENT_ARTIFACT' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const collaboration = state.scores.collaboration + 0.5
  const next: WorldState = {
    ...state,
    scores: { ...state.scores, collaboration },
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyMoveAgent(
  state: WorldState,
  action: Extract<Action, { type: 'MOVE_AGENT' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const cellX = Math.floor(action.x)
  const cellY = Math.floor(action.y)
  // Builder back-wall access rule: may traverse row y=2 (BACK_WALL_ROWS-1) for any task/object.
  const builderBackWallMoveAllowed =
    req.agent.role === 'Builder' &&
    cellY === BACK_WALL_ROWS - 1
  if (isCellBlockedForAgents(state, cellX, cellY) && !builderBackWallMoveAllowed) {
    return failAndPush(state, event, {
      type: 'FAIL_ACTION',
      agentId: action.agentId,
      reason: 'Cannot move onto furniture (workstation, table, etc.) — cell is blocked',
      attemptedAction: action,
    })
  }
  const occupiedByOther = state.agents.some(
    (a) => a.id !== action.agentId && Math.floor(a.x) === cellX && Math.floor(a.y) === cellY
  )
  if (occupiedByOther) {
    return failAndPush(state, event, {
      type: 'FAIL_ACTION',
      agentId: action.agentId,
      reason: 'Cell already occupied by another agent',
      attemptedAction: action,
    })
  }

  const x = cellX + 0.5
  const y = cellY + 0.5
  const next: WorldState = {
    ...state,
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, x, y } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyChatEntry(
  state: WorldState,
  action: Extract<Action, { type: 'SAY' | 'THOUGHT' }>,
  eventIndex: number,
  kind: 'say' | 'thought',
  maxTextLen: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const agent = getAgent(state, action.agentId)
  if (!agent || !action.text.trim()) return { state: pushLastEvent(state, event), event }
  const entry: ChatEntry = {
    id: nextId('chat', state.tick, eventIndex),
    agentId: action.agentId,
    agentName: agent.name,
    text: action.text.trim().slice(0, maxTextLen),
    kind,
    tick: state.tick,
    at: Date.now(),
  }
  const chatLog = [...(state.chatLog ?? []), entry].slice(-MAX_CHAT_LOG)
  return { state: pushLastEvent({ ...state, chatLog }, event), event }
}

function applySetIntent(
  state: WorldState,
  action: Extract<Action, { type: 'SET_INTENT' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const next: WorldState = {
    ...state,
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, currentIntent: action.intent, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyVote(
  state: WorldState,
  action: Extract<Action, { type: 'VOTE' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)

  const byArtifact = { ...(state.artifactVotes ?? {}) }
  const votes = { ...(byArtifact[action.artifactId] ?? {}), [action.agentId]: action.vote }
  byArtifact[action.artifactId] = votes
  const next: WorldState = {
    ...state,
    artifactVotes: byArtifact,
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyAddMemory(
  state: WorldState,
  action: Extract<Action, { type: 'ADD_MEMORY' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const agent = getAgent(state, action.agentId)
  if (!agent || !action.content.trim()) return { state: pushLastEvent(state, event), event }

  const entry: MemoryEntry = {
    content: action.content.trim().slice(0, 500),
    tick: state.tick,
    importance: action.importance ?? 0.5,
    kind: action.kind ?? 'episodic',
  }
  const memory = [...(agent.memory ?? []), entry]
    .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5) || b.tick - a.tick)
    .slice(0, MAX_MEMORY_PER_AGENT)
  const next: WorldState = {
    ...state,
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, memory, lastActionAtTick: state.tick } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyLoadSkill(
  state: WorldState,
  action: Extract<Action, { type: 'LOAD_SKILL' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const req = requireAgent(state, action)
  if ('fail' in req) return failAndPush(state, event, req.fail)
  const agent = req.agent
  const loaded = agent.loadedSkills ?? []
  if (loaded.includes(action.skillName)) return { state: pushLastEvent(state, event), event }
  const next: WorldState = {
    ...state,
    agents: state.agents.map((a) =>
      a.id === action.agentId ? { ...a, loadedSkills: [...loaded, action.skillName] } : a
    ),
  }
  return { state: pushLastEvent(next, event), event }
}

function applyFailAction(
  state: WorldState,
  action: Extract<Action, { type: 'FAIL_ACTION' }>,
  eventIndex: number
): { state: WorldState; event: Event } {
  const event: Event = { tick: state.tick, eventIndex, action }
  const wastePenalty = state.scores.wastePenalty + 1
  const next: WorldState = {
    ...state,
    scores: { ...state.scores, wastePenalty },
  }
  return { state: pushLastEvent(next, event), event }
}

export function reduce(
  state: WorldState,
  action: Action,
  eventIndex: number
): { state: WorldState; event: Event } {
  const parsed = ActionSchema.safeParse(action)
  if (!parsed.success) {
    const fail: Action = { type: 'FAIL_ACTION', agentId: (action as Action & { agentId?: string }).agentId ?? 'unknown', reason: parsed.error.message, attemptedAction: action }
    return applyFailAction(state, fail, eventIndex)
  }
  const a = parsed.data
  switch (a.type) {
    case 'HUMAN_PLACE_ITEM':
      return applyHumanPlaceItem(state, a, eventIndex)
    case 'HUMAN_PAINT_FLOOR_SLICE':
      return applyHumanPaintFloorSlice(state, a, eventIndex)
    case 'HUMAN_REMOVE_ITEM':
      return applyHumanRemoveItem(state, a, eventIndex)
    case 'PLACE_ITEM':
      return applyPlaceItem(state, a, eventIndex)
    case 'EXPAND_GRID':
      return applyExpandGrid(state, a, eventIndex)
    case 'CREATE_ARTIFACT':
      return applyCreateArtifact(state, a, eventIndex)
    case 'ASK_AGENT':
    case 'RESPOND_AGENT':
    case 'REQUEST_REVIEW':
    case 'REVIEW_RESULT':
    case 'DELEGATE_TASK':
    case 'COMMENT_ARTIFACT':
      return applyCollaboration(state, a, eventIndex)
    case 'MOVE_AGENT':
      return applyMoveAgent(state, a, eventIndex)
    case 'SAY':
      return applyChatEntry(state, a, eventIndex, 'say', 500)
    case 'THOUGHT':
      return applyChatEntry(state, a, eventIndex, 'thought', 300)
    case 'SET_INTENT':
      return applySetIntent(state, a, eventIndex)
    case 'VOTE':
      return applyVote(state, a, eventIndex)
    case 'ADD_MEMORY':
      return applyAddMemory(state, a, eventIndex)
    case 'LOAD_SKILL':
      return applyLoadSkill(state, a, eventIndex)
    case 'FAIL_ACTION':
      return applyFailAction(state, a, eventIndex)
    default: {
      const fail: Action = { type: 'FAIL_ACTION', agentId: (a as Action & { agentId?: string }).agentId ?? 'unknown', reason: 'Unknown action type', attemptedAction: a }
      return applyFailAction(state, fail, eventIndex)
    }
  }
}

export function advanceTick(state: WorldState): WorldState {
  return { ...state, tick: state.tick + 1 }
}
