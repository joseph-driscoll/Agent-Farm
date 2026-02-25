/**
 * NavGrid: one authoritative walkability + collision layer.
 * Rebuild when: items change, walls/floor paint (cells) change, grid size changes.
 * Used by: reducer (MOVE_AGENT), steering (pathing), views (movement + debug overlay).
 */

import type { WorldState } from './schemas.js'
import { BACK_WALL_ROWS, getCell, getBlockingItemsAt, getPlacedItemsAt, isCellBlockedForAgents, isInBounds } from './worldState.js'

export interface NavGrid {
  /** Grid dimensions (same as world). */
  width: number
  height: number
  /** walkable[y][x] — agent can stand here. */
  walkable: boolean[][]
  /** cost[y][x] — optional; 1 = normal, higher = avoid (for A* later). */
  cost: number[][]
  /** blockedBy[y][x] — optional debug: defId of blocking item or 'wall'. */
  blockedBy: (string | null)[][]
}

/**
 * Build nav grid from world. Walkable = not blocked for agents.
 * Uses same rule as back wall for all wall tiles (wall_top, wall_*, etc.) — isCellBlockedForAgents.
 */
export function buildNavGrid(world: WorldState): NavGrid {
  const w = world.gridWidth
  const h = world.gridHeight
  const walkable: boolean[][] = []
  const cost: number[][] = []
  const blockedBy: (string | null)[][] = []

  for (let y = 0; y < h; y++) {
    walkable.push([])
    cost.push([])
    blockedBy.push([])
    for (let x = 0; x < w; x++) {
      let block: string | null = null
      if (!isInBounds(world, x, y)) {
        block = 'bounds'
      } else if (isCellBlockedForAgents(world, x, y)) {
        const cell = getCell(world, x, y)
        if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) block = 'wall'
        else {
          const at = getPlacedItemsAt(world, x, y)
          const wallPiece = at.find((item) => item.defId.startsWith('wall_'))
          if (wallPiece) block = wallPiece.defId
          else {
            const blocking = getBlockingItemsAt(world, x, y)
            if (blocking.length > 0) block = blocking[0]!.defId
          }
        }
      }
      const ok = block == null
      walkable[y]!.push(ok)
      cost[y]!.push(ok ? 1 : 0)
      blockedBy[y]!.push(block)
    }
  }

  return { width: w, height: h, walkable, cost, blockedBy }
}

export function isWalkable(nav: NavGrid, cx: number, cy: number): boolean {
  const x = Math.floor(cx)
  const y = Math.floor(cy)
  if (y < 0 || y >= nav.height || x < 0 || x >= nav.width) return false
  return nav.walkable[y]![x]!
}

/** 4-neighbor offsets (orthogonal). */
const NEIGHBORS = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
] as const

export interface FindPathOptions {
  /** When true, allow pathfinding to start from an unwalkable cell (e.g. Builder on back wall). Used so Builder can path off back wall. */
  allowStartUnwalkable?: boolean
}

/**
 * A* path from (fromX, fromY) to (toX, toY). Returns cells from start to end inclusive, or null if unreachable.
 * Uses nav.cost (1 = walkable); avoids re-evaluating "best neighbor" every frame so agents follow a stable path.
 */
export function findPath(
  nav: NavGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options?: FindPathOptions
): Array<{ x: number; y: number }> | null {
  const fx = Math.floor(fromX)
  const fy = Math.floor(fromY)
  const tx = Math.floor(toX)
  const ty = Math.floor(toY)
  const startOk = options?.allowStartUnwalkable ? true : isWalkable(nav, fx, fy)
  if (!startOk || !isWalkable(nav, tx, ty)) return null
  if (fx === tx && fy === ty) return [{ x: fx, y: fy }]

  const key = (x: number, y: number) => `${x},${y}`
  const cost = (x: number, y: number) => (nav.cost[y]?.[x] ?? 0) || 1
  const heuristic = (x: number, y: number) => (tx - x) ** 2 + (ty - y) ** 2

  const open = new Map<string, { x: number; y: number; g: number; f: number }>()
  const closed = new Set<string>()
  const cameFrom = new Map<string, { x: number; y: number }>()
  const startKey = key(fx, fy)
  open.set(startKey, { x: fx, y: fy, g: 0, f: heuristic(fx, fy) })

  while (open.size > 0) {
    let bestKey: string | null = null
    let bestF = Infinity
    for (const [k, v] of open) {
      if (v.f < bestF) {
        bestF = v.f
        bestKey = k
      }
    }
    if (bestKey == null) break
    const cur = open.get(bestKey)!
    open.delete(bestKey)
    closed.add(bestKey)
    if (cur.x === tx && cur.y === ty) {
      const path: Array<{ x: number; y: number }> = []
      let u: { x: number; y: number } = { x: cur.x, y: cur.y }
      for (;;) {
        path.unshift(u)
        const pk = key(u.x, u.y)
        const prev = cameFrom.get(pk)
        if (!prev) break
        u = prev
      }
      return path
    }
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cur.x + dx
      const ny = cur.y + dy
      if (nx < 0 || nx >= nav.width || ny < 0 || ny >= nav.height) continue
      if (!isWalkable(nav, nx, ny)) continue
      const nk = key(nx, ny)
      if (closed.has(nk)) continue
      const g = cur.g + cost(nx, ny)
      const existing = open.get(nk)
      if (existing != null && g >= existing.g) continue
      cameFrom.set(nk, { x: cur.x, y: cur.y })
      open.set(nk, { x: nx, y: ny, g, f: g + heuristic(nx, ny) })
    }
  }
  return null
}

/**
 * One step toward target: pick the walkable neighbor that minimizes distance to (toX, toY).
 * Same rule as back wall and wall tiles — agents never step onto blocked cells.
 */
export function getNextCellToward(
  nav: NavGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): { x: number; y: number } | null {
  const fx = Math.floor(fromX)
  const fy = Math.floor(fromY)
  const tx = Math.floor(toX)
  const ty = Math.floor(toY)

  if (fx === tx && fy === ty) return null

  let best: { x: number; y: number; dist: number } | null = null
  for (const [dx, dy] of NEIGHBORS) {
    const nx = fx + dx
    const ny = fy + dy
    if (nx < 0 || nx >= nav.width || ny < 0 || ny >= nav.height) continue
    if (!isWalkable(nav, nx, ny)) continue
    const dist = (tx - nx) ** 2 + (ty - ny) ** 2
    if (best == null || dist < best.dist) best = { x: nx, y: ny, dist }
  }
  return best ? { x: best.x, y: best.y } : null
}

/**
 * All walkable neighbors of (fromX, fromY) sorted by distance to (toX, toY).
 * Used to try alternative directions when the best step would overlap a wall (sprite contact).
 */
export function getWalkableNeighborsToward(
  nav: NavGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Array<{ x: number; y: number }> {
  const fx = Math.floor(fromX)
  const fy = Math.floor(fromY)
  const tx = Math.floor(toX)
  const ty = Math.floor(toY)
  if (fx === tx && fy === ty) return []
  const out: Array<{ x: number; y: number; dist: number }> = []
  for (const [dx, dy] of NEIGHBORS) {
    const nx = fx + dx
    const ny = fy + dy
    if (nx < 0 || nx >= nav.width || ny < 0 || ny >= nav.height) continue
    if (!isWalkable(nav, nx, ny)) continue
    const dist = (tx - nx) ** 2 + (ty - ny) ** 2
    out.push({ x: nx, y: ny, dist })
  }
  out.sort((a, b) => a.dist - b.dist)
  return out.map(({ x, y }) => ({ x, y }))
}

/**
 * True if a point (posX, posY) with given radius (in cell units) overlaps any non-walkable cell.
 * Use sprite radius ~0.5 so 1 cell wall is a perfect blocker.
 */
export function overlapsBlockedCell(nav: NavGrid, posX: number, posY: number, radiusCells: number): boolean {
  const minCx = Math.floor(posX - radiusCells)
  const maxCx = Math.floor(posX + radiusCells)
  const minCy = Math.floor(posY - radiusCells)
  const maxCy = Math.floor(posY + radiusCells)
  const radiusSq = radiusCells * radiusCells
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const blocked = cx < 0 || cx >= nav.width || cy < 0 || cy >= nav.height || !isWalkable(nav, cx, cy)
      if (!blocked) continue
      const nearestX = Math.max(cx, Math.min(posX, cx + 1))
      const nearestY = Math.max(cy, Math.min(posY, cy + 1))
      const dx = posX - nearestX
      const dy = posY - nearestY
      // Strict overlap only (<), so touching an edge is allowed and prevents half-cell early stops.
      if (dx * dx + dy * dy < radiusSq) return true
    }
  }
  return false
}

/**
 * Snap (x, y) to nearest walkable cell (for target from intent).
 * Prefer exact cell if walkable; else nearest walkable in expanding ring.
 */
export function snapToWalkable(nav: NavGrid, x: number, y: number): { x: number; y: number } | null {
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  if (isWalkable(nav, cx, cy)) return { x: cx, y: cy }
  const maxDist = Math.max(nav.width, nav.height)
  for (let r = 1; r <= maxDist; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const nx = cx + dx
        const ny = cy + dy
        if (isWalkable(nav, nx, ny)) return { x: nx, y: ny }
      }
    }
  }
  return null
}
