import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorldState } from '../engine/schemas'
import { BACK_WALL_ROWS, getAgentFacingWhenOnChair } from '../engine/worldState'
import { buildNavGrid, findPath } from '../engine/navGrid'
import { getTargetCellForIntent, pruneSteeringCaches } from './steering'
import { maybeSendAgentPos, pruneSentPosCache } from './sendPos'

const CELLS_PER_SECOND = 2
const AGENT_POS_EPS = 1e-6

export function normalizeAgentPos(pos: { x: number; y: number }): { x: number; y: number } {
  const nx = Math.abs(pos.x - Math.round(pos.x)) < AGENT_POS_EPS ? Math.floor(pos.x) + 0.5 : pos.x
  const ny = Math.abs(pos.y - Math.round(pos.y)) < AGENT_POS_EPS ? Math.floor(pos.y) + 0.5 : pos.y
  return { x: nx, y: ny }
}

function snapToCellCenterGrid(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(pos.x * 2) / 2,
    y: Math.round(pos.y * 2) / 2,
  }
}

export interface ClientMotionState {
  displayPositions: Record<string, { x: number; y: number }>
  agentFacing: Record<string, 'left' | 'right'>
  chairCellFrames: Record<string, number>
}

type MotionFsmState = 'idle' | 'pathing' | 'approach_chair' | 'seated'
interface AgentMotionFsm {
  state: MotionFsmState
  target: { x: number; y: number } | null
  waypoints: Array<{ x: number; y: number }>
  waypointIndex: number
  lastIntent: string
  lastStepAtMs: number
  currentCell: { x: number; y: number }
  transition:
    | {
        from: { x: number; y: number }
        to: { x: number; y: number }
        startAtMs: number
        durationMs: number
      }
    | null
}

function isOrthogonalNeighbor(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y) === 1
}

/**
 * Client-only visual movement simulation.
 * This keeps rendering components pure while preserving smooth interpolation.
 */
export function useClientMotion(world: WorldState): ClientMotionState {
  const latestWorldRef = useRef(world)
  latestWorldRef.current = world
  const [displayPositions, setDisplayPositions] = useState<Record<string, { x: number; y: number }>>({})
  const displayPositionsRef = useRef(displayPositions)
  displayPositionsRef.current = displayPositions
  const agentFacingRef = useRef<Record<string, 'left' | 'right'>>({})
  const chairCellFramesRef = useRef<Record<string, number>>({})
  const fsmRef = useRef<Record<string, AgentMotionFsm>>({})

  const nav = useMemo(() => buildNavGrid(world), [world.gridWidth, world.gridHeight, world.items, world.cells])

  useEffect(() => {
    const liveAgentIds = world.agents.map((a) => a.id)
    pruneSteeringCaches(liveAgentIds)
    pruneSentPosCache(liveAgentIds)
  }, [world.agents])

  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      const state = latestWorldRef.current
      const stepPeriodMs = 1000 / CELLS_PER_SECOND
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
        const curCell = { x: Math.floor(pos.x), y: Math.floor(pos.y) }
        const intent = a.currentIntent ?? 'hold'
        const targetCell = getTargetCellForIntent(worldWithClientPos, a.id, intent, nav) ?? curCell
        const isSitIntent = intent === 'sit_in_chair' || intent === 'sit' || intent === 'research'
        const chairAtTarget = getAgentFacingWhenOnChair(state, targetCell.x, targetCell.y) != null
        const fsm = fsmRef.current[a.id] ?? {
          state: 'idle',
          target: null,
          waypoints: [],
          waypointIndex: 0,
          lastIntent: intent,
          lastStepAtMs: now,
          currentCell: curCell,
          transition: null,
        }
        fsmRef.current[a.id] = fsm
        // Keep FSM cell synced if world teleports/loads.
        if (Math.abs(fsm.currentCell.x - curCell.x) + Math.abs(fsm.currentCell.y - curCell.y) > 1) {
          fsm.currentCell = curCell
          fsm.transition = null
        }

        const needsRetarget =
          fsm.target == null ||
          fsm.target.x !== targetCell.x ||
          fsm.target.y !== targetCell.y ||
          fsm.lastIntent !== intent ||
          fsm.waypoints.length === 0 ||
          fsm.waypointIndex >= fsm.waypoints.length

        if (needsRetarget) {
          fsm.target = targetCell
          fsm.lastIntent = intent
          const onBackWall = fsm.currentCell.y < BACK_WALL_ROWS
          const allowStartUnwalkable = a.role === 'Builder' && onBackWall
          const path = findPath(nav, fsm.currentCell.x, fsm.currentCell.y, targetCell.x, targetCell.y, {
            allowStartUnwalkable: allowStartUnwalkable || undefined,
          })
          if (path && path.length > 1) {
            fsm.waypoints = path.slice(1)
            fsm.waypointIndex = 0
            fsm.state = isSitIntent && chairAtTarget ? 'approach_chair' : 'pathing'
          } else {
            fsm.waypoints = []
            fsm.waypointIndex = 0
            fsm.state = isSitIntent && chairAtTarget && curCell.x === targetCell.x && curCell.y === targetCell.y ? 'seated' : 'idle'
          }
        }

        if (fsm.state === 'seated') {
          const onChair = getAgentFacingWhenOnChair(state, curCell.x, curCell.y) != null
          if (!isSitIntent || !onChair) {
            fsm.state = 'idle'
          }
        }

        // Smooth centerline movement: deterministic cell stepping + tween between centers.
        if (fsm.transition) {
          const t = Math.min(1, (now - fsm.transition.startAtMs) / fsm.transition.durationMs)
          if (t >= 1) {
            fsm.currentCell = fsm.transition.to
            fsm.transition = null
          }
        }
        if (fsm.state !== 'seated') {
          const canStep = fsm.transition == null && now - fsm.lastStepAtMs >= stepPeriodMs
          if (canStep) {
            const waypoint = fsm.waypoints[fsm.waypointIndex] ?? null
            if (waypoint) {
              if (isOrthogonalNeighbor(fsm.currentCell, waypoint)) {
                fsm.transition = {
                  from: fsm.currentCell,
                  to: waypoint,
                  startAtMs: now,
                  durationMs: stepPeriodMs,
                }
                fsm.waypointIndex += 1
                fsm.lastStepAtMs = now
              } else {
                // Safety: never allow diagonal/long transitions; force replan from current cell.
                fsm.target = null
                fsm.waypoints = []
                fsm.waypointIndex = 0
                fsm.state = 'idle'
              }
            }
          }
        }
        if (fsm.waypointIndex >= fsm.waypoints.length) {
          const atTarget = fsm.target != null && fsm.currentCell.x === fsm.target.x && fsm.currentCell.y === fsm.target.y
          const targetIsChair = fsm.target != null && getAgentFacingWhenOnChair(state, fsm.target.x, fsm.target.y) != null
          fsm.state = atTarget && isSitIntent && targetIsChair ? 'seated' : 'idle'
        }

        let finalPos = snapToCellCenterGrid({ x: fsm.currentCell.x + 0.5, y: fsm.currentCell.y + 0.5 })
        if (fsm.transition) {
          const t = Math.min(1, (now - fsm.transition.startAtMs) / fsm.transition.durationMs)
          const ix = fsm.transition.from.x + (fsm.transition.to.x - fsm.transition.from.x) * t
          const iy = fsm.transition.from.y + (fsm.transition.to.y - fsm.transition.from.y) * t
          finalPos = { x: ix + 0.5, y: iy + 0.5 }
        }
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
          const faceDx = targetCell.x - curCell.x
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
  }, [nav])

  return {
    displayPositions,
    agentFacing: agentFacingRef.current,
    chairCellFrames: chairCellFramesRef.current,
  }
}

