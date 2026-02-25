/**
 * Grid view: office grid for AI agents (build/place furniture, meet, sit). 16×16px cells; workstations
 * are 5×2 cells (top row + desk row; bottom row is full 5 cells). Stacked desks use 1px overlap so columns render with no visible gap.
 */

import { useEffect, useRef, useState, useMemo, Fragment } from 'react'
import type { WorldState } from '../engine/schemas'
import { getItemDef, BACK_WALL_ROWS, getChairFlipped, getChairAtlasName, getComputerAtlasName, getValidPlacementTiles, getDeletablePlacementCells, getAgentFacingWhenOnChair, hasWorkstationAt, hasWorkstationDirectlyAbove, isWorkstationTopCornerCell, isStructuralWallPiece } from '../engine/worldState'
import { getSprite, getSheetUrl, getAgentSprite, getAgentHairSprite, getTwoPartTopSliceName, objectHasTopLayer, CELL_PX, CELL_PX_Y } from '../config/spriteRegistry'
import { WORKSTATION_TOP_REGION, WORKSTATION_BOTTOM_REGION } from '../config/workstationPieces'
import { getTargetCellForIntent, noteBlockedCellForAgent } from '../runtime/steering'
import { getDisplayNameForRole } from '../runtime/agentRoles'
import { buildNavGrid, findPath, getWalkableNeighborsToward, overlapsBlockedCell } from '../engine/navGrid'
import { maybeSendAgentPos } from '../runtime/sendPos'

const BG = '#12121c'
const WALL_ROW = '#2d3142'
const FLOOR_ROW = '#1e2030'
const CANVAS_BORDER = '#3d4451'
const AGENT_COLORS: Record<string, string> = {
  Nova: '#ff6b6b',
  Sage: '#4ecdc4',
  Pixel: '#ffe66d',
}
const CELLS_PER_SECOND = 2
const ARRIVE_DIST = 0.03
/** Slightly under 0.5 so agents can walk into chair cells (next to workstations) without overlapping the desk and vibrating. 0.45 gives breathing room when off-center. */
const AGENT_RADIUS_CELLS = 0.45
/** How long each agent's last say stays in their bubble. */
const BUBBLE_TTL_MS = 4_000
const AGENT_POS_EPS = 1e-6
const RECENT_CELL_MEMORY = 8
const RECENT_CELL_PENALTY = 2.5
const BACKTRACK_PENALTY = 1.75
const MAX_MOVEMENT_TRACE_EVENTS = 20000

type MovementTraceEvent =
  | {
      kind: 'init' | 'arrive'
      atMs: number
      tick: number
      frame: number
      agentId: string
      agentName: string
      intent: string
      cell: { x: number; y: number }
      targetCell: { x: number; y: number } | null
      pos: { x: number; y: number }
    }
  | {
      kind: 'blocked'
      atMs: number
      tick: number
      frame: number
      agentId: string
      agentName: string
      intent: string
      fromCell: { x: number; y: number }
      attemptedCell: { x: number; y: number } | null
      targetCell: { x: number; y: number } | null
      pos: { x: number; y: number }
    }
  | {
      kind: 'cell_change'
      atMs: number
      tick: number
      frame: number
      agentId: string
      agentName: string
      intent: string
      fromCell: { x: number; y: number }
      toCell: { x: number; y: number }
      targetCell: { x: number; y: number } | null
      pos: { x: number; y: number }
    }

/** Movement/collision uses cell-center coords (cell + 0.5). Normalize legacy integer coords on read. */
function normalizeAgentPos(pos: { x: number; y: number }): { x: number; y: number } {
  const nx = Math.abs(pos.x - Math.round(pos.x)) < AGENT_POS_EPS ? Math.floor(pos.x) + 0.5 : pos.x
  const ny = Math.abs(pos.y - Math.round(pos.y)) < AGENT_POS_EPS ? Math.floor(pos.y) + 0.5 : pos.y
  return { x: nx, y: ny }
}

/** Snap to the middle of 16×16 grid cells: positions are half-integers only (0.5, 1.5, 2.5, …) so agents walk only along cell centers and the lines between them (vertical/horizontal). */
function snapToCellCenterGrid(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(pos.x * 2) / 2,
    y: Math.round(pos.y * 2) / 2,
  }
}

/** Defs that render behind other objects (wall tiles; floor is drawn from cells via floorFromSlice). */
const BACK_LAYER_DEF_IDS: string[] = []
/** zIndex for objects with a top layer (plants, watercooler, etc.) — above agents so agents appear to walk behind them. Chairs use lower z so agents draw on top when sitting. */
const TOP_LAYER_Z = 35
/** Post-its/memos on workstation top corner: above workstation (10), below chair top (12). */
const WORKSTATION_SURFACE_Z = 11
const CHAIR_TOP_Z = 12
/** Agents draw above chairs; plants/watercooler top layers use TOP_LAYER_Z > AGENT_Z so agents walk behind those. */
const AGENT_Z = 30
/** When agent is on a workstation cell (desk row), draw behind the desk so they don’t appear to walk over it. */
const AGENT_BEHIND_DESK_Z = 8
/** Agent hair (and name/bubble) draw in front of plant/object top layers so hair isn’t hidden behind foliage. */
const AGENT_HAIR_Z = 40
/** Agent with visible chat bubble draws above other agents so the bubble is on top. */
const AGENT_BUBBLE_Z = 50

interface GridViewProps {
  world: WorldState
  showGrid?: boolean
  showCellCoordinates?: boolean
  /** When set, grid cells are clickable and this is called with (x, y) on click (e.g. for human placement or delete). */
  onCellClick?: (x: number, y: number) => void
  /** When place tool is open and this is set, valid placement tiles (green) are highlighted for that item. */
  selectedDefId?: string | null
  placeToolOpen?: boolean
  /** When true, click removes the object at the cell instead of placing. */
  deleteMode?: boolean
  onAgentClick?: (agentId: string) => void
  selectedAgentId?: string | null
  /** Cells from queued proposals (planned section) to highlight */
  plannedCells?: Array<{ x: number; y: number }>
}

function computeNavSig(world: WorldState): string {
  const itemsPart =
    world.items.length === 0
      ? '0'
      : `${world.items.length}:${world.items[world.items.length - 1]!.defId}:${world.items[world.items.length - 1]!.x},${world.items[world.items.length - 1]!.y}`
  const cellsPart =
    world.cells?.length
      ? `${world.cells.length}:${world.cells[0]!.kind}:${world.cells[world.cells.length - 1]!.kind}`
      : 'nocells'
  return `${world.gridWidth}x${world.gridHeight}|${itemsPart}|${cellsPart}`
}

function GridView({
  world,
  showGrid = false,
  showCellCoordinates = false,
  onCellClick,
  selectedDefId = null,
  placeToolOpen = false,
  deleteMode = false,
  onAgentClick,
  selectedAgentId = null,
  plannedCells = [],
}: GridViewProps) {
  const { gridWidth, gridHeight, items, agents, chatLog = [] } = world
  const latestWorldRef = useRef(world)
  latestWorldRef.current = world
  const [displayPositions, setDisplayPositions] = useState<Record<string, { x: number; y: number }>>({})
  const displayPositionsRef = useRef(displayPositions)
  displayPositionsRef.current = displayPositions
  const [previewCell, setPreviewCell] = useState<{ x: number; y: number } | null>(null)
  const lastAgentCellRef = useRef<Record<string, { x: number; y: number }>>({})
  const committedStepRef = useRef<Record<string, { x: number; y: number } | null>>({})
  const recentCellsRef = useRef<Record<string, Array<{ x: number; y: number }>>>({})
  const pathRef = useRef<Record<string, { path: Array<{ x: number; y: number }>; targetKey: string }>>({})
  const lastMoveDirRef = useRef<Record<string, { dx: number; dy: number }>>({})
  /** Frames in current cell when cell is a chair; only apply sit nudge after 2+ frames to avoid walk→sit transition glitch. */
  const chairCellFramesRef = useRef<Record<string, number>>({})
  const showSkeleton = Boolean(placeToolOpen && selectedDefId && !['chair', 'computer'].includes(selectedDefId))
  const agentFacingRef = useRef<Record<string, 'left' | 'right'>>({})
  const [sheetSize, setSheetSize] = useState<{ w: number; h: number } | null>(null)
  const frameRef = useRef(0)

  const navSig = useMemo(() => computeNavSig(world), [world.gridWidth, world.gridHeight, world.items, world.cells])

  /** Memoize to avoid recomputing on every render (world updates often from broadcast) — prevents slowdown/OOM when place tool open. */
  const validPlacementTiles = useMemo(() => {
    if (!selectedDefId) return []
    let tiles = getValidPlacementTiles(world, selectedDefId, { allowPerimeterWallTop: true })
    if (isStructuralWallPiece(selectedDefId)) {
      const gw = world.gridWidth
      const gh = world.gridHeight
      tiles = [...tiles].sort((a, b) => {
        const aPerim = a.x === 0 || a.x === gw - 1 || a.y === gh - 1 ? 1 : 0
        const bPerim = b.x === 0 || b.x === gw - 1 || b.y === gh - 1 ? 1 : 0
        if (aPerim !== bPerim) return bPerim - aPerim
        return a.y !== b.y ? a.y - b.y : a.x - b.x
      })
    }
    return tiles
  }, [world.tick, world.items.length, world.gridWidth, world.gridHeight, selectedDefId])
  const deletablePlacementCells = useMemo(
    () => getDeletablePlacementCells(world),
    [world.tick, world.items.length, world.gridWidth, world.gridHeight]
  )

  const navRef = useRef<ReturnType<typeof buildNavGrid> | null>(null)
  const navSigRef = useRef<string>('')

  useEffect(() => {
    navSigRef.current = navSig
    navRef.current = buildNavGrid(world)
  }, [navSig, world])

  const movementTraceRef = useRef<{
    enabled: boolean
    startedAtMs: number | null
    events: MovementTraceEvent[]
  }>({
    enabled: false,
    startedAtMs: null,
    events: [],
  })

  const appendMovementTrace = (evt: MovementTraceEvent) => {
    const trace = movementTraceRef.current
    if (!trace.enabled) return
    trace.events.push(evt)
    if (trace.events.length > MAX_MOVEMENT_TRACE_EVENTS) {
      trace.events.splice(0, trace.events.length - MAX_MOVEMENT_TRACE_EVENTS)
    }
  }

  useEffect(() => {
    const sheetUrl = getSheetUrl()
    if (!sheetUrl) return
    const img = new Image()
    img.src = sheetUrl
    img.onload = () => setSheetSize({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  useEffect(() => {
    const g = globalThis as {
      __agentMovementDebug?: {
        start: () => void
        stop: () => void
        clear: () => void
        export: () => void
        snapshot: () => { enabled: boolean; startedAtMs: number | null; count: number; lastEvent: MovementTraceEvent | null }
      }
    }
    g.__agentMovementDebug = {
      start: () => {
        movementTraceRef.current.enabled = true
        if (movementTraceRef.current.startedAtMs == null) movementTraceRef.current.startedAtMs = Date.now()
      },
      stop: () => {
        movementTraceRef.current.enabled = false
      },
      clear: () => {
        movementTraceRef.current.events = []
        movementTraceRef.current.startedAtMs = Date.now()
      },
      export: () => {
        const trace = movementTraceRef.current
        const payload = {
          capturedAt: new Date().toISOString(),
          startedAtMs: trace.startedAtMs,
          world: {
            tick: latestWorldRef.current.tick,
            gridWidth: latestWorldRef.current.gridWidth,
            gridHeight: latestWorldRef.current.gridHeight,
          },
          events: trace.events,
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `agent-movement-trace-${Date.now()}.json`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      },
      snapshot: () => {
        const trace = movementTraceRef.current
        return {
          enabled: trace.enabled,
          startedAtMs: trace.startedAtMs,
          count: trace.events.length,
          lastEvent: trace.events.length > 0 ? trace.events[trace.events.length - 1]! : null,
        }
      },
    }
    return () => {
      delete g.__agentMovementDebug
    }
  }, [])

  const lastTickTimeRef = useRef<number>(0)

  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      frameRef.current += 1
      const frame = frameRef.current
      const state = latestWorldRef.current
      const dtSec = lastTickTimeRef.current ? (now - lastTickTimeRef.current) / 1000 : 1 / 60
      lastTickTimeRef.current = now
      const stepPerFrame = CELLS_PER_SECOND * Math.min(dtSec, 0.1)
      const nav = navRef.current ?? buildNavGrid(state)
      const positions = displayPositionsRef.current
      const worldWithClientPos: WorldState = {
        ...state,
        agents: state.agents.map((a) => {
          const p = positions[a.id] ?? normalizeAgentPos({ x: a.x, y: a.y })
          return { ...a, x: p.x, y: p.y }
        }),
      }
      const next: Record<string, { x: number; y: number }> = {}
      for (const a of state.agents) {
        const pos = positions[a.id] ?? normalizeAgentPos({ x: a.x, y: a.y })
        if (!positions[a.id]) {
          appendMovementTrace({
            kind: 'init',
            atMs: Date.now(),
            tick: state.tick,
            frame,
            agentId: a.id,
            agentName: a.name,
            intent: a.currentIntent ?? 'hold',
            cell: { x: Math.floor(pos.x), y: Math.floor(pos.y) },
            targetCell: null,
            pos: { x: pos.x, y: pos.y },
          })
        }
        const curCell = lastAgentCellRef.current[a.id] ?? { x: Math.floor(pos.x), y: Math.floor(pos.y) }
        const intent = a.currentIntent ?? 'hold'
        const targetCell = getTargetCellForIntent(worldWithClientPos, a.id, intent, nav) ?? curCell
        const targetKey = `${targetCell.x},${targetCell.y}`
        const neighbors = getWalkableNeighborsToward(nav, curCell.x, curCell.y, targetCell.x, targetCell.y)
        const recent = recentCellsRef.current[a.id] ?? []
        const lastMoveDir = lastMoveDirRef.current[a.id]
        const scoreNeighbor = (cell: { x: number; y: number }) => {
          const dist = (targetCell.x - cell.x) ** 2 + (targetCell.y - cell.y) ** 2
          const seenRecently = recent.some((c) => c.x === cell.x && c.y === cell.y)
          const revisitPenalty = seenRecently ? RECENT_CELL_PENALTY : 0
          const stepDx = cell.x - curCell.x
          const stepDy = cell.y - curCell.y
          const backtrackPenalty =
            lastMoveDir && stepDx === -lastMoveDir.dx && stepDy === -lastMoveDir.dy
              ? BACKTRACK_PENALTY
              : 0
          return dist + revisitPenalty + backtrackPenalty
        }
        const orderedNeighbors = [...neighbors].sort((aCell, bCell) => scoreNeighbor(aCell) - scoreNeighbor(bCell))
        const committed = committedStepRef.current[a.id]
        const committedUsable = !!committed &&
          Math.abs(committed.x - curCell.x) + Math.abs(committed.y - curCell.y) === 1 &&
          !!nav.walkable[committed.y]?.[committed.x]

        let nextCellFromPath: { x: number; y: number } | null = null
        const cached = pathRef.current[a.id]
        const pathValid =
          cached &&
          cached.targetKey === targetKey &&
          cached.path.length >= 1 &&
          cached.path[0]!.x === curCell.x &&
          cached.path[0]!.y === curCell.y
        if (pathValid && cached!.path.length >= 2) {
          nextCellFromPath = cached!.path[1]!
        } else if (curCell.x !== targetCell.x || curCell.y !== targetCell.y) {
          const path = findPath(nav, curCell.x, curCell.y, targetCell.x, targetCell.y)
          if (path && path.length >= 2) {
            pathRef.current[a.id] = { path: [...path], targetKey }
            nextCellFromPath = path[1]!
          } else {
            delete pathRef.current[a.id]
          }
        } else {
          delete pathRef.current[a.id]
        }

        let nextCell: { x: number; y: number } | null = committedUsable ? committed! : (nextCellFromPath ?? orderedNeighbors[0] ?? null)
        // Only allow orthogonal steps (no diagonal): exactly one of dx,dy must be ±1
        const isOrthogonal = (c: { x: number; y: number }) =>
          (Math.abs(c.x - curCell.x) + Math.abs(c.y - curCell.y)) === 1
        if (nextCell && !isOrthogonal(nextCell)) {
          nextCell = null
          committedStepRef.current[a.id] = null
          delete pathRef.current[a.id]
        }
        if (!committedUsable) committedStepRef.current[a.id] = nextCell
        // When no next cell: if we're in a chair cell (by position) with sit intent, pull to cell center so we snap into the chair and don't clip.
        const cellFromPos = { x: Math.floor(pos.x), y: Math.floor(pos.y) }
        const atChairTarget =
          !nextCell &&
          targetCell &&
          (intent === 'sit_in_chair' || intent === 'sit' || intent === 'research') &&
          getAgentFacingWhenOnChair(state, targetCell.x, targetCell.y) != null &&
          cellFromPos.x === targetCell.x &&
          cellFromPos.y === targetCell.y
        const destX = nextCell ? nextCell.x + 0.5 : atChairTarget ? targetCell!.x + 0.5 : pos.x
        const destY = nextCell ? nextCell.y + 0.5 : atChairTarget ? targetCell!.y + 0.5 : pos.y
        const dx = destX - pos.x
        const dy = destY - pos.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const chairTarget =
          targetCell &&
          (intent === 'sit_in_chair' || intent === 'sit' || intent === 'research') &&
          getAgentFacingWhenOnChair(state, targetCell.x, targetCell.y) != null
        let newPos = pos
        if (dist < ARRIVE_DIST) {
          newPos = { x: destX, y: destY }
          if (nextCell) {
            lastAgentCellRef.current[a.id] = nextCell
            committedStepRef.current[a.id] = null
            const pathEntry = pathRef.current[a.id]
            if (pathEntry && pathEntry.path.length >= 2 && pathEntry.path[1]!.x === nextCell.x && pathEntry.path[1]!.y === nextCell.y) {
              pathEntry.path.shift()
            }
          }
        } else {
          const step = Math.min(stepPerFrame, dist)
          // Snap earlier when approaching a chair so we never hover near the boundary and trigger overlap
          if (chairTarget && dist < 0.12) {
            newPos = { x: destX, y: destY }
            if (nextCell) {
              lastAgentCellRef.current[a.id] = nextCell
              committedStepRef.current[a.id] = null
              const pathEntry = pathRef.current[a.id]
              if (pathEntry && pathEntry.path.length >= 2 && pathEntry.path[1]!.x === nextCell.x && pathEntry.path[1]!.y === nextCell.y) {
                pathEntry.path.shift()
              }
            }
          } else {
          // Cardinal-only: move along one axis; keep the other at current position to avoid snapping/jump when switching direction
          const adx = Math.abs(dx)
          const ady = Math.abs(dy)
          let proposed: { x: number; y: number }
          if (adx >= ady) {
            const moveX = Math.sign(dx) * Math.min(step, adx)
            proposed = { x: pos.x + moveX, y: pos.y }
          } else {
            const moveY = Math.sign(dy) * Math.min(step, ady)
            proposed = { x: pos.x, y: pos.y + moveY }
          }
          const wouldOverlap = (nx: number, ny: number) =>
            overlapsBlockedCell(nav, nx, ny, AGENT_RADIUS_CELLS)
          const nextIsChair = nextCell != null && getAgentFacingWhenOnChair(state, nextCell.x, nextCell.y) != null
          const ignoreOverlapForChairApproach =
            nextIsChair && (intent === 'sit_in_chair' || intent === 'sit' || intent === 'research')
          // If the step lands in a walkable cell (e.g. chair), allow it — avoids vibration when circle grazes adjacent desk
          const proposedCell = { x: Math.floor(proposed.x), y: Math.floor(proposed.y) }
          const proposedCellWalkable = !!nav.walkable[proposedCell.y]?.[proposedCell.x]
          if (proposedCellWalkable || ignoreOverlapForChairApproach) {
            newPos = proposed
            if (nextCell && dist <= stepPerFrame + ARRIVE_DIST) {
              lastAgentCellRef.current[a.id] = nextCell
              const pathEntry = pathRef.current[a.id]
              if (pathEntry && pathEntry.path.length >= 2 && pathEntry.path[1]!.x === nextCell.x && pathEntry.path[1]!.y === nextCell.y) {
                pathEntry.path.shift()
              }
            }
          } else if (wouldOverlap(proposed.x, proposed.y)) {
            if (nextCell) {
              noteBlockedCellForAgent(a.id, nextCell)
              committedStepRef.current[a.id] = null
              delete pathRef.current[a.id]
              appendMovementTrace({
                kind: 'blocked',
                atMs: Date.now(),
                tick: state.tick,
                frame,
                agentId: a.id,
                agentName: a.name,
                intent,
                fromCell: { x: curCell.x, y: curCell.y },
                attemptedCell: nextCell,
                targetCell,
                pos: { x: pos.x, y: pos.y },
              })
            }
            for (let i = 1; i < orderedNeighbors.length; i++) {
              const alt = orderedNeighbors[i]!
              const ax = alt.x + 0.5
              const ay = alt.y + 0.5
              const adx = ax - pos.x
              const ady = ay - pos.y
              const adist = Math.sqrt(adx * adx + ady * ady)
              if (adist < 1e-6) continue
              const astep = Math.min(stepPerFrame, adist)
              const aax = Math.abs(adx)
              const aay = Math.abs(ady)
              const altPos =
                aax >= aay
                  ? { x: pos.x + Math.sign(adx) * Math.min(astep, aax), y: pos.y }
                  : { x: pos.x, y: pos.y + Math.sign(ady) * Math.min(astep, aay) }
              const altCellWalkable = !!nav.walkable[alt.y]?.[alt.x]
              if (altCellWalkable || !wouldOverlap(altPos.x, altPos.y)) {
                nextCell = alt
                newPos = altCellWalkable ? altPos : altPos
                committedStepRef.current[a.id] = alt
                lastAgentCellRef.current[a.id] = alt
                break
              }
            }
          } else {
            newPos = proposed
            if (nextCell && dist <= stepPerFrame + ARRIVE_DIST) {
              lastAgentCellRef.current[a.id] = nextCell
              const pathEntry = pathRef.current[a.id]
              if (pathEntry && pathEntry.path.length >= 2 && pathEntry.path[1]!.x === nextCell.x && pathEntry.path[1]!.y === nextCell.y) {
                pathEntry.path.shift()
              }
            }
          }
          }
        }
        const nextCellNow = { x: Math.floor(newPos.x), y: Math.floor(newPos.y) }
        const movedCell = nextCellNow.x !== curCell.x || nextCellNow.y !== curCell.y
        if (movedCell) {
          const history = recentCellsRef.current[a.id] ?? []
          history.push(nextCellNow)
          if (history.length > RECENT_CELL_MEMORY) history.shift()
          recentCellsRef.current[a.id] = history
          lastMoveDirRef.current[a.id] = {
            dx: nextCellNow.x - curCell.x,
            dy: nextCellNow.y - curCell.y,
          }
          appendMovementTrace({
            kind: 'cell_change',
            atMs: Date.now(),
            tick: state.tick,
            frame,
            agentId: a.id,
            agentName: a.name,
            intent,
            fromCell: { x: curCell.x, y: curCell.y },
            toCell: { x: nextCellNow.x, y: nextCellNow.y },
            targetCell,
            pos: { x: newPos.x, y: newPos.y },
          })
        } else if (dist < ARRIVE_DIST && nextCell) {
          appendMovementTrace({
            kind: 'arrive',
            atMs: Date.now(),
            tick: state.tick,
            frame,
            agentId: a.id,
            agentName: a.name,
            intent,
            cell: { x: nextCell.x, y: nextCell.y },
            targetCell,
            pos: { x: newPos.x, y: newPos.y },
          })
        }
        // Only snap to cell-center grid when we've arrived; during movement use raw newPos to avoid vibrating/jitter.
        const finalPos = dist < ARRIVE_DIST ? snapToCellCenterGrid(newPos) : newPos
        next[a.id] = finalPos
        const ws = (globalThis as { __AGENT_FARM_WS__?: WebSocket | null }).__AGENT_FARM_WS__ ?? null
        maybeSendAgentPos(ws, a.id, finalPos.x, finalPos.y)
        const cellNow = { x: Math.floor(finalPos.x), y: Math.floor(finalPos.y) }
        const chairFacingNow = getAgentFacingWhenOnChair(state, cellNow.x, cellNow.y)
        if (chairFacingNow != null) {
          agentFacingRef.current[a.id] = chairFacingNow
          chairCellFramesRef.current[a.id] = Math.min(10, (chairCellFramesRef.current[a.id] ?? 0) + 1)
        } else {
          chairCellFramesRef.current[a.id] = 0
          const faceDx = (nextCell ?? targetCell).x - curCell.x
          agentFacingRef.current[a.id] = faceDx > 0 ? 'right' : faceDx < 0 ? 'left' : (agentFacingRef.current[a.id] ?? 'right')
        }
      }
      setDisplayPositions((prev) => {
        let changed = false
        const out: Record<string, { x: number; y: number }> = { ...prev }
        for (const id of Object.keys(next)) {
          const a = next[id]!
          const b = prev[id]
          if (!b || a.x !== b.x || a.y !== b.y) {
            out[id] = a
            changed = true
          }
        }
        return changed ? out : prev
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const gridW = Math.round(gridWidth * CELL_PX)
  const gridH = Math.round(gridHeight * CELL_PX_Y)
  const width = gridW
  const height = gridH
  const cw = Math.round(CELL_PX)
  const ch = Math.round(CELL_PX_Y)

  const sheetUrl = getSheetUrl()
  const [bubbleTick, setBubbleTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setBubbleTick((n) => n + 1), 2000)
    return () => clearInterval(id)
  }, [])
  const lastSayByAgent = useMemo(() => {
    const now = Date.now()
    const m = new Map<string, string>()
    const log = chatLog ?? []
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i]!
      if (e.at == null || now - e.at > BUBBLE_TTL_MS) continue
      if (e.kind === 'say' && !m.has(e.agentId)) m.set(e.agentId, e.text)
    }
    return m
  }, [chatLog, bubbleTick])

  return (
    <div
      style={{
        width,
        height,
        background: BG,
        border: `1px solid ${CANVAS_BORDER}`,
        boxSizing: 'border-box',
        overflow: 'hidden',
        position: 'relative',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        imageRendering: 'pixelated',
      }}
      onMouseLeave={() => showSkeleton && setPreviewCell(null)}
    >
      {/* Wall rows (top 3) — 1px overlap between rows to hide subpixel seams */}
      {Array.from({ length: BACK_WALL_ROWS }, (_, y) => (
        <div
          key={`wall-${y}`}
          style={{
            position: 'absolute',
            left: 0,
            top: Math.round(y * ch),
            width: gridW,
            height: ch + 1,
            background: WALL_ROW,
            zIndex: 0,
          }}
        />
      ))}

      {/* Full floor slice — main_office_floor.json slice starts at y:1 to skip 1px blue row at top of asset */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: Math.round(BACK_WALL_ROWS * ch),
          width: gridW,
          height: Math.round((gridHeight - BACK_WALL_ROWS) * ch),
          backgroundImage: 'url(/main-office-floor.png)',
          backgroundSize: `${gridW}px ${Math.round((gridHeight - BACK_WALL_ROWS) * ch)}px`,
          backgroundPosition: '0 -1px',
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
          zIndex: 0,
        }}
      />

      {/* Cover tiles — 1px overlap so adjacent tiles never show a gap */}
      {(world.cells ?? []).map((c) => {
        if (c.kind !== 'floor' || c.floorFromSlice) return null
        return (
          <div
            key={`cover-${c.x}-${c.y}`}
            style={{
              position: 'absolute',
              left: Math.round(c.x * cw),
              top: Math.round(c.y * ch),
              width: cw + 1,
              height: ch + 1,
              background: FLOOR_ROW,
              zIndex: 1,
            }}
          />
        )
      })}

      {showGrid && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: gridW,
            height: gridH,
            pointerEvents: 'none',
            zIndex: 4,
            backgroundImage: `repeating-linear-gradient(90deg, rgba(180,140,255,0.25) 0px, rgba(180,140,255,0.25) 1px, transparent 1px, transparent ${cw}px), repeating-linear-gradient(0deg, rgba(180,140,255,0.25) 0px, rgba(180,140,255,0.25) 1px, transparent 1px, transparent ${ch}px)`,
            backgroundPosition: '-1px 0, 0 0',
          }}
        />
      )}

      {/* Planned section: tiles from queued proposals (build queue) */}
      {plannedCells.length > 0 &&
        plannedCells.map(({ x, y }) => (
          <div
            key={`planned-${x}-${y}`}
            style={{
              position: 'absolute',
              left: x * CELL_PX,
              top: y * CELL_PX_Y,
              width: CELL_PX,
              height: CELL_PX_Y,
              background: 'rgba(96, 165, 250, 0.35)',
              border: '1px solid rgba(96, 165, 250, 0.6)',
              pointerEvents: 'none',
              zIndex: 18,
            }}
            title="Planned (in build queue)"
          />
        ))}

      {/* Deletable cells when delete mode is on — red = click to remove object */}
      {deleteMode &&
        deletablePlacementCells.slice(0, 120).map(({ x, y }) => (
          <div
            key={`delete-${x}-${y}`}
            style={{
              position: 'absolute',
              left: x * CELL_PX,
              top: y * CELL_PX_Y,
              width: CELL_PX,
              height: CELL_PX_Y,
              background: 'rgba(239, 68, 68, 0.4)',
              border: '1px solid rgba(239, 68, 68, 0.7)',
              pointerEvents: 'none',
              zIndex: 20,
            }}
          />
        ))}

      {/* Click overlay for placement tool: when onCellClick is set, cells are clickable */}
      {onCellClick &&
        Array.from({ length: gridHeight }, (_, y) =>
          Array.from({ length: gridWidth }, (_, x) => (
            <div
              key={`click-${x}-${y}`}
              style={{
                position: 'absolute',
                left: x * CELL_PX,
                top: y * CELL_PX_Y,
                width: CELL_PX,
                height: CELL_PX_Y,
                cursor: 'pointer',
                zIndex: 20,
              }}
              title={deleteMode ? `Remove object at (${x}, ${y})` : `Place at (${x}, ${y})`}
              onClick={() => onCellClick(x, y)}
              onMouseMove={() => showSkeleton && setPreviewCell({ x, y })}
              onKeyDown={(e) => e.key === 'Enter' && onCellClick(x, y)}
              role="button"
              tabIndex={0}
            />
          ))
        )}

      {/* Hover feedback: anchor cursor at bottom-left of footprint; green only when origin is engine-valid for this item. */}
      {showSkeleton && selectedDefId && previewCell != null && (() => {
        const cx = previewCell.x
        const cy = previewCell.y
        const def = getItemDef(world, selectedDefId)
        const [fw, fh] = def?.footprint ?? [1, 1]
        const validSet = new Set(validPlacementTiles.map((t) => `${t.x},${t.y}`))
        // Treat hovered cell as bottom-left of footprint; engine origin is top-left.
        const originX = cx
        const originY = cy - (fh - 1)
        const valid = originY >= 0 && validSet.has(`${originX},${originY}`)
        const highlightW = fw * CELL_PX
        const highlightH = fh * CELL_PX_Y
        return (
          <div
            style={{
              position: 'absolute',
              left: originX * CELL_PX,
              top: originY * CELL_PX_Y,
              width: highlightW,
              height: highlightH,
              background: valid ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
              border: `2px solid ${valid ? 'rgba(34, 197, 94, 1)' : 'rgba(239, 68, 68, 1)'}`,
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 21,
              boxSizing: 'border-box',
            }}
          />
        )
      })()}

      {/* Placement (x,y): (0,0) top-left, y increases downward */}
      {showCellCoordinates && Array.from({ length: gridHeight }, (_, y) =>
        Array.from({ length: gridWidth }, (_, x) => (
          <div
            key={`cell-${x}-${y}`}
            style={{
              position: 'absolute',
              left: x * CELL_PX + 1,
              top: y * CELL_PX_Y + 11,
              fontSize: 2,
              fontWeight: 100,
              color: '#fff',
              fontFamily: 'system-ui, monospace',
              pointerEvents: 'none',
              zIndex: 1,
            }}
            title={`(${x}, ${y}) — top-left is (0,0)`}
          >
            {x},{y}
          </div>
        ))
      )}

      {/* Items: draw floor/wall first (far back), then other items on top */}
      {sheetSize && sheetUrl &&
        [...items]
          .sort((a, b) => ((BACK_LAYER_DEF_IDS.includes(a.defId) || a.defId.startsWith('wall_')) ? 0 : 1) - ((BACK_LAYER_DEF_IDS.includes(b.defId) || b.defId.startsWith('wall_')) ? 0 : 1))
          .map((item) => {
          const def = getItemDef(world, item.defId)
          if (!def) return null // skip legacy/unknown defs (floor is now paint-slice only)
          const [fw, fh] = def.footprint
          const baseX = item.x * CELL_PX
          const baseY = item.y * CELL_PX_Y
          const boxW = fw * CELL_PX
          const boxH = fh * CELL_PX_Y

          if (item.defId === 'workstation') {
            const t = WORKSTATION_TOP_REGION
            const b = WORKSTATION_BOTTOM_REGION
            const cellH = CELL_PX_Y
            const topScaleX = boxW / t.w
            const hasAbove = hasWorkstationDirectlyAbove(world, item)
            const topDrawH = hasAbove ? cellH + 1 : cellH
            const topScaleY = topDrawH / t.h
            const bottomW = Math.round(b.w * topScaleX)
            const bottomScaleX = topScaleX
            const bottomScaleY = cellH / b.h
            const bottomLeft = baseX + Math.round((b.x - t.x) * topScaleX)
            return (
              <div key={item.id} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 10 }}>
                <div
                  style={{
                    position: 'absolute',
                    left: baseX,
                    top: baseY,
                    width: boxW,
                    height: topDrawH,
                    backgroundImage: `url(${sheetUrl})`,
                    backgroundSize: `${Math.round(sheetSize.w * topScaleX)}px ${Math.round(sheetSize.h * topScaleY)}px`,
                    backgroundPosition: `${Math.round(-t.x * topScaleX)}px ${Math.round(-t.y * topScaleY)}px`,
                    backgroundRepeat: 'no-repeat',
                    imageRendering: 'pixelated',
                    zIndex: 0,
                  }}
                />
                {/* Bottom overlaps top by 1px to hide seam; height cellH+2 so it extends 1px lower; stacked desk 1px lower so not under chair/workstation above */}
                <div
                  style={{
                    position: 'absolute',
                    left: bottomLeft,
                    top: hasAbove ? baseY + cellH : baseY + cellH - 1,
                    width: bottomW,
                    height: cellH + 2,
                    backgroundImage: `url(${sheetUrl})`,
                    backgroundSize: `${Math.round(sheetSize.w * bottomScaleX)}px ${Math.round(sheetSize.h * bottomScaleY)}px`,
                    backgroundPosition: `${Math.round(-b.x * bottomScaleX)}px ${Math.round(-b.y * bottomScaleY)}px`,
                    backgroundRepeat: 'no-repeat',
                    imageRendering: 'pixelated',
                    zIndex: 1,
                  }}
                />
              </div>
            )
          }

          const spriteName =
            item.defId === 'chair'
              ? getChairAtlasName(world, item)
              : item.defId === 'computer'
                ? getComputerAtlasName(world, item)
                : undefined
          const sprite = spriteName ? getSprite(spriteName) : getSprite(item.defId)
          if (!sprite) return null
          const { region } = sprite
          // Use sprite pixel size for tables (48×16, 32×16); computer is 2×2 (32×24); two-part (plant/watercooler) = exactly one cell per slice (total 1×2); wall/floor tiles = 1px overlap for seamless edges
          const isTable = item.defId === 'table_large' || item.defId === 'table_small'
          const isTwoPartTall = getTwoPartTopSliceName(item.defId) && (item.defId === 'plant' || item.defId === 'plant_bushy' || item.defId === 'plant_large' || item.defId === 'watercooler')
          // Wall/floor tiles use 1px overlap for seams; wall_art (calendar 2×1, others 1×1) uses footprint from def
          const isTileOverlap = item.defId === 'floor' || (item.defId.startsWith('wall_') && !item.defId.startsWith('wall_art'))
          const tableTop = isTable ? baseY + CELL_PX_Y - region.h : baseY
          const drawW = item.defId === 'computer' ? CELL_PX * 2 : (isTable ? region.w : isTwoPartTall ? CELL_PX : isTileOverlap ? cw + 1 : boxW)
          const drawH = item.defId === 'computer' ? CELL_PX_Y * 2 : (isTable ? region.h : isTwoPartTall ? CELL_PX_Y : isTileOverlap ? ch + 1 : boxH)
          const scaleX = drawW / region.w
          const scaleY = drawH / region.h
          const flipHorizontal = item.defId === 'chair' && getChairFlipped(world, item.x, item.y)
          const isLeftComputer = item.defId === 'computer' && getComputerAtlasName(world, item).endsWith('_left')
          const computerLeft = item.defId === 'computer' ? (isLeftComputer ? baseX : baseX - CELL_PX) : baseX
          const hasSeparateTopSlice = item.defId !== 'chair' && Boolean(getTwoPartTopSliceName(item.defId))
          // Computer sits ON the desk: draw one row higher so the 2-tall sprite occupies (desk row - 1) and desk row
          const computerTop = item.defId === 'computer' ? baseY - CELL_PX_Y : baseY
          // Chair: left-side = baseX; right-side (flipped) needs +1 cell so after scaleX(-1) with transformOrigin left it lands in the correct cell
          const chairLeft = item.defId === 'chair' && flipHorizontal ? baseX + CELL_PX : baseX
          const chairBaseTop = baseY - 1
          const chairTopTop = baseY - CELL_PX_Y
          const itemLeft = item.defId === 'computer' ? computerLeft : item.defId === 'chair' ? chairLeft : (isTable ? baseX : isTileOverlap ? Math.round(item.x * cw) : baseX)
          // Two-part tall (plant/watercooler): base is exactly one cell tall at item.y; top slice is exactly one cell above.
          const itemTop = item.defId === 'computer' ? computerTop : item.defId === 'chair' ? chairBaseTop : (isTable ? tableTop : isTwoPartTall ? baseY : isTileOverlap ? Math.round(item.y * ch) : baseY)

          const itemDiv = (
            <div
              key={item.id}
              style={{
                position: 'absolute',
                left: itemLeft,
                top: itemTop,
                width: drawW,
                height: drawH,
                zIndex: ((item.defId === 'post_its' || item.defId === 'wall_art_memo_a' || item.defId === 'wall_art_memo_b') && isWorkstationTopCornerCell(world, item.x, item.y)) ? WORKSTATION_SURFACE_Z : (objectHasTopLayer(item.defId) && item.defId !== 'chair' && !hasSeparateTopSlice) ? TOP_LAYER_Z : (BACK_LAYER_DEF_IDS.includes(item.defId) || item.defId.startsWith('wall_')) ? 3 : (item.defId === 'computer' ? 10 : item.defId === 'chair' ? 11 : 5),
                backgroundImage: `url(${sheetUrl})`,
                backgroundSize: `${Math.round(sheetSize.w * scaleX)}px ${Math.round(sheetSize.h * scaleY)}px`,
                backgroundPosition: `${Math.round(-region.x * scaleX)}px ${Math.round(-region.y * scaleY)}px`,
                backgroundRepeat: 'no-repeat',
                imageRendering: 'pixelated',
                transform: flipHorizontal ? 'scaleX(-1)' : undefined,
                transformOrigin: 'left center',
              }}
            />
          )

          if (item.defId === 'chair') {
            const topSprite = getSprite(getChairAtlasName(world, item) + '_top')
            const topDiv = topSprite ? (
              <div
                key={`${item.id}-top`}
                style={{
                  position: 'absolute',
                  left: chairLeft,
                  top: chairTopTop,
                  width: boxW,
                  height: boxH,
                  zIndex: CHAIR_TOP_Z,
                  backgroundImage: `url(${sheetUrl})`,
                  backgroundSize: `${Math.round(sheetSize.w * (boxW / topSprite.region.w))}px ${Math.round(sheetSize.h * (boxH / topSprite.region.h))}px`,
                  backgroundPosition: `${Math.round(-topSprite.region.x * (boxW / topSprite.region.w))}px ${Math.round(-topSprite.region.y * (boxH / topSprite.region.h))}px`,
                  backgroundRepeat: 'no-repeat',
                  imageRendering: 'pixelated',
                  transform: flipHorizontal ? 'scaleX(-1)' : undefined,
                  transformOrigin: 'left center',
                }}
              />
            ) : null
            return <Fragment key={item.id}>{itemDiv}{topDiv}</Fragment>
          }

          // Plant, watercooler: 1×2 with top slice above base (trash/recycling are 1×1)
          const topSliceName = getTwoPartTopSliceName(item.defId)
          if (topSliceName && (item.defId === 'plant' || item.defId === 'plant_bushy' || item.defId === 'plant_large' || item.defId === 'watercooler')) {
            const topSprite = getSprite(topSliceName)
            const topDiv = topSprite ? (
              <div
                key={`${item.id}-top`}
                style={{
                  position: 'absolute',
                  left: baseX,
                  top: baseY - CELL_PX_Y,
                  width: CELL_PX,
                  height: CELL_PX_Y,
                  zIndex: TOP_LAYER_Z,
                  backgroundImage: `url(${sheetUrl})`,
                  backgroundSize: `${Math.round(sheetSize.w * (CELL_PX / topSprite.region.w))}px ${Math.round(sheetSize.h * (CELL_PX_Y / topSprite.region.h))}px`,
                  backgroundPosition: `${Math.round(-topSprite.region.x * (CELL_PX / topSprite.region.w))}px ${Math.round(-topSprite.region.y * (CELL_PX_Y / topSprite.region.h))}px`,
                  backgroundRepeat: 'no-repeat',
                  imageRendering: 'pixelated',
                }}
              />
            ) : null
            return <Fragment key={item.id}>{itemDiv}{topDiv}</Fragment>
          }

          return itemDiv
        })}

      {/* Agents (above objects) — depth-sort by y then x so agents can walk behind each other; hair already renders over body. */}
      {[...agents]
        .sort((a, b) => {
          const posA = displayPositions[a.id] ?? normalizeAgentPos({ x: a.x, y: a.y })
          const posB = displayPositions[b.id] ?? normalizeAgentPos({ x: b.x, y: b.y })
          return posA.y !== posB.y ? posA.y - posB.y : posA.x - posB.x
        })
        .map((a) => {
        const pos = displayPositions[a.id] ?? normalizeAgentPos({ x: a.x, y: a.y })
        const cellX = Math.floor(pos.x)
        const cellY = Math.floor(pos.y)
        const px = Math.round(pos.x * CELL_PX)
        const py = Math.round(pos.y * CELL_PX_Y)
        const agentSprite = getAgentSprite(a.role)
        const agentHair = getAgentHairSprite(a.role)
        const facing = agentFacingRef.current[a.id] ?? 'right'
        const say = lastSayByAgent.get(a.id)
        const bodyR = agentSprite?.region
        const hairR = agentHair?.region
        const cellSize = Math.max(CELL_PX, CELL_PX_Y)
        // Atlas: hair above body, same cell scale (16px). Stack hair on top, body below.
        const bodyW = bodyR ? (bodyR.w / 16) * CELL_PX : cellSize
        const bodyH = bodyR ? (bodyR.h / 16) * CELL_PX_Y : cellSize
        const hairW = hairR ? (hairR.w / 16) * CELL_PX : bodyW
        const hairH = hairR ? (hairR.h / 16) * CELL_PX_Y : bodyH
        const combinedW = Math.max(CELL_PX, bodyW, hairW)
        const combinedH = (agentHair ? hairH : 0) + bodyH
        let containerLeft = px - combinedW / 2
        let containerTop = py + CELL_PX_Y / 2 - combinedH
        // When sitting in chair: nudge up 8px; right 2px on left-side chair, left 2px on right-side chair.
        // Only apply after 6+ frames in chair cell so we're fully snapped and not mid-step (avoids clipping / stuck between walk and sit).
        const chairFacing = getAgentFacingWhenOnChair(world, cellX, cellY)
        const settledInChair = (chairCellFramesRef.current[a.id] ?? 0) >= 6
        if (chairFacing != null && settledInChair) {
          containerTop -= 8
          containerLeft += chairFacing === 'right' ? 2 : -2
        }
        const bodyScale = bodyR && bodyR.w > 0 ? bodyW / bodyR.w : 1
        const hairScale = hairR && hairR.w > 0 ? hairW / hairR.w : 1

        const containerStyle = {
          position: 'absolute' as const,
          left: containerLeft,
          top: containerTop,
          width: combinedW,
          height: combinedH,
          display: 'flex' as const,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          pointerEvents: 'none' as const,
        }

        if (agentSprite && sheetSize) {
          const behindDesk = hasWorkstationAt(world, cellX, cellY)
          const agentClickable = Boolean(onAgentClick && !onCellClick)
          const agentSelected = selectedAgentId === a.id
          return (
            <Fragment key={a.id}>
              {agentClickable && (
                <button
                  type="button"
                  onClick={() => onAgentClick?.(a.id)}
                  title={`Inspect ${a.name} (${getDisplayNameForRole(a.role)})`}
                  style={{
                    position: 'absolute',
                    left: containerLeft - 3,
                    top: containerTop - 3,
                    width: combinedW + 6,
                    height: combinedH + 6,
                    borderRadius: 6,
                    border: agentSelected ? '1px solid #5eead4' : 'none',
                    background: agentSelected ? 'rgba(94,234,212,0.08)' : 'transparent',
                    zIndex: AGENT_BUBBLE_Z + 1,
                    pointerEvents: 'auto',
                    cursor: 'pointer',
                  }}
                />
              )}
              {/* Body layer: behind plant/object top layers so agent appears to walk behind foliage; behind desk when on workstation cell */}
              <div
                style={{
                  ...containerStyle,
                  zIndex: behindDesk ? AGENT_BEHIND_DESK_Z : AGENT_Z,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    width: bodyW,
                    height: bodyH,
                    left: (combinedW - bodyW) / 2,
                    top: (agentHair ? hairH : 0),
                    transform: facing === 'left' ? 'scaleX(-1)' : undefined,
                    transformOrigin: 'center center',
                    backgroundImage: `url(${agentSprite.sheetUrl})`,
                    backgroundSize: `${Math.round(sheetSize.w * bodyScale)}px ${Math.round(sheetSize.h * bodyScale)}px`,
                    backgroundPosition: `${Math.round(-agentSprite.region.x * bodyScale)}px ${Math.round(-agentSprite.region.y * bodyScale)}px`,
                    backgroundRepeat: 'no-repeat',
                    imageRendering: 'pixelated',
                  }}
                />
              </div>
              {/* Hair + UI layer: same behind-desk order when on workstation cell */}
              <div
                style={{
                  ...containerStyle,
                  zIndex: say ? AGENT_BUBBLE_Z : (behindDesk ? AGENT_BEHIND_DESK_Z + 1 : AGENT_HAIR_Z),
                }}
                title={`${a.name} (${getDisplayNameForRole(a.role)})`}
              >
                {agentHair && (
                  <div
                    style={{
                      position: 'absolute',
                      width: hairW,
                      height: hairH,
                      left: (combinedW - hairW) / 2,
                      top: 0,
                      transform: facing === 'left' ? 'scaleX(-1)' : undefined,
                      transformOrigin: 'center center',
                      backgroundImage: `url(${agentHair.sheetUrl})`,
                      backgroundSize: `${Math.round(sheetSize.w * hairScale)}px ${Math.round(sheetSize.h * hairScale)}px`,
                      backgroundPosition: `${Math.round(-agentHair.region.x * hairScale)}px ${Math.round(-agentHair.region.y * hairScale)}px`,
                      backgroundRepeat: 'no-repeat',
                      imageRendering: 'pixelated',
                    }}
                  />
                )}
                {chairFacing != null && settledInChair && a.name !== 'Nova' && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: 0,
                      transform: `translateX(calc(-50% + ${chairFacing === 'right' ? -12 : 14}px)) translateY(-25px)${chairFacing === 'right' ? ' scaleX(-1)' : ''}`,
                      transformOrigin: 'center center',
                      fontSize: 14,
                      lineHeight: 1,
                      pointerEvents: 'none',
                    }}
                    title="Thinking..."
                  >
                    💭
                  </div>
                )}
                {a.name === 'Nova' && chairFacing != null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: 0,
transform: 'translateX(-50%) translateY(-30px)',
                    transformOrigin: 'center center',
                    fontSize: 14,
                    lineHeight: 1,
                    pointerEvents: 'none',
                    }}
                    title={(a.currentIntent ?? '') === 'research' ? 'Running Tavily research' : 'At computer — Tavily research'}
                  >
                    💡
                  </div>
                )}
                {say && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      bottom: '100%',
                      transform: 'translateX(-50%) translateY(-4px)',
                      minWidth: 64,
                      maxWidth: 160,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: 'rgba(24,24,36,0.95)',
                      border: `1px solid ${(AGENT_COLORS[a.name] ?? '#888')}66`,
                      fontSize: 3,
                      lineHeight: 1.3,
                      color: '#e2e8f0',
                      fontFamily: 'system-ui, sans-serif',
                      wordBreak: 'break-word',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={say}
                  >
                    {say.length > 80 ? `${say.slice(0, 77)}…` : say}
                  </div>
                )}
              </div>
            </Fragment>
          )
        }

        return (
          <Fragment key={a.id}>
            {onAgentClick && !onCellClick && (
              <button
                type="button"
                onClick={() => onAgentClick(a.id)}
                title={`Inspect ${a.name} (${getDisplayNameForRole(a.role)})`}
                style={{
                  position: 'absolute',
                  left: containerLeft - 3,
                  top: containerTop - 3,
                  width: combinedW + 6,
                  height: combinedH + 6,
                  borderRadius: 6,
                  border: selectedAgentId === a.id ? '1px solid #5eead4' : 'none',
                  background: selectedAgentId === a.id ? 'rgba(94,234,212,0.08)' : 'transparent',
                  zIndex: AGENT_BUBBLE_Z + 1,
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                }}
              />
            )}
            <div
              style={{
                ...containerStyle,
                zIndex: hasWorkstationAt(world, cellX, cellY) ? AGENT_BEHIND_DESK_Z : AGENT_Z,
              }}
              title={`${a.name} (${getDisplayNameForRole(a.role)})`}
            >
              <div
                style={{
                  width: cellSize * 0.7,
                  height: cellSize * 0.7,
                  borderRadius: '50%',
                  background: AGENT_COLORS[a.name] ?? '#888',
                  border: '2px solid rgba(255,255,255,0.4)',
                }}
              />
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

export { GridView }
