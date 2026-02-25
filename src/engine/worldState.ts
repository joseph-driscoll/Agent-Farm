// src/engine/worldState.ts
/**
 * Initial WorldState and pure helpers.
 * No mutation — reducer produces new state.
 */

import type { WorldState, Cell, Agent, PlacedItem, ItemDef, Artifact } from './schemas.js'

/** Grid size in cells. Pixel size = gridWidth*CELL_PX × gridHeight*CELL_PX_Y (spriteRegistry; row height 12px so 24px workstation stacks). */
const DEFAULT_GRID_WIDTH = 21
const DEFAULT_GRID_HEIGHT = 15 /* 3 back wall + 12 floor rows */

/** Back wall at top of room: 3 rows of wall (planks), full width. Rest is floor. Clouds sit above this in the view.
 *  In pixel layout, the boundary row (bottom of back wall / top of floor) must be drawn as wall, not floor texture,
 *  to avoid a 1px blue seam — see GridView.tsx. */
export const BACK_WALL_ROWS = 3

/** Structural wall pieces (same placement rules as wall_top: perimeter door gap, chair trap, 1-cell corridor). Corner/edge pieces go in corners (e.g. perimeter (0,2), (width-1,2); section corners). */
const WALL_PIECE_DEF_IDS = [
  'wall_top',
  'wall_top_left',
  'wall_top_right',
  'wall_left',
  'wall_right',
  'wall_bottom',
  'wall_bottom_left',
  'wall_bottom_right',
] as const
export function isStructuralWallPiece(defId: string): boolean {
  return (WALL_PIECE_DEF_IDS as readonly string[]).includes(defId)
}
/** First row where floor items (workstations, chairs, etc.) can be built — 3 grid cells below the back wall. */
export const BUILD_START_ROW = BACK_WALL_ROWS + 3

/** Workstations: max 3 stacked per column; at least 2 empty grid cells between columns. Must be at or below BUILD_START_ROW. */
export const WORKSTATION_STACK_MAX = 3
/** Minimum gap between workstation columns (so they don't touch). */
export const WORKSTATION_GAP_CELLS = 2
/** Aisle = gap between two columns only when gap is 2 or 3 cells; if gap > 3, that space is not an aisle and building is allowed. */
export const AISLE_GAP_MAX = 3

/** When using interior wall to create room borders, leave 2–3 empty cells for a doorway (min 2, max 3; design guidance; not enforced). */
export const DOORWAY_CELLS = 3

/** Placement failure reason when an agent is on the cell; we retry placement until the spot is clear (do not reject the proposal). */
export const AGENT_IN_THE_WAY_REASON = 'Agent in the way — move off the spot before placing'

function defaultCells(width: number, height: number): Cell[] {
  const cells: Cell[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = y < BACK_WALL_ROWS ? 'wall' : 'floor'
      cells.push({ x, y, kind, roomId: 'main' })
    }
  }
  return cells
}

const INITIAL_ITEM_DEFS: ItemDef[] = [
  // Structure
  { id: 'floor', name: 'Floor', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_top', name: 'Wall (top)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_top_left', name: 'Wall (top-left)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_top_right', name: 'Wall (top-right)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_left', name: 'Wall (left)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_right', name: 'Wall (right)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_bottom', name: 'Wall (bottom)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_bottom_left', name: 'Wall (bottom-left)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'wall_bottom_right', name: 'Wall (bottom-right)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  // Workstations
  { id: 'workstation', name: 'Workstation', footprint: [5, 2], aestheticValue: 4, powerValue: 4 },
  { id: 'chair', name: 'Chair', footprint: [1, 1], aestheticValue: 1, powerValue: 1 },
  { id: 'computer', name: 'Computer', footprint: [1, 1], aestheticValue: 1, powerValue: 2, unlockEffects: ['tavily_research'] },
  // Tables
  { id: 'table_large', name: 'Meeting Table', footprint: [3, 1], aestheticValue: 2, powerValue: 2 },
  { id: 'table_small', name: 'Small Table', footprint: [2, 1], aestheticValue: 1, powerValue: 0 },
  // Back wall / amenities
  { id: 'bookshelf', name: 'Bookshelf', footprint: [2, 3], aestheticValue: 1, powerValue: 4, unlockEffects: ['tavily_research'] },
  { id: 'vending_machine', name: 'Vending machine', footprint: [2, 3], aestheticValue: 1, powerValue: 2 },
  { id: 'coffee_maker', name: 'Coffee Maker', footprint: [1, 1], aestheticValue: 1, powerValue: 1 },
  // Plants
  { id: 'plant', name: 'Plant (smooth)', footprint: [1, 1], aestheticValue: 2, powerValue: 0 },
  { id: 'plant_bushy', name: 'Plant (bushy)', footprint: [1, 1], aestheticValue: 2, powerValue: 0 },
  { id: 'plant_large', name: 'Plant (large)', footprint: [1, 1], aestheticValue: 2, powerValue: 0 },
  // Break room / lounge
  { id: 'watercooler', name: 'Water cooler', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'coffee_left', name: 'Coffee (left)', footprint: [1, 2], aestheticValue: 1, powerValue: 0 },
  { id: 'coffee_right', name: 'Coffee (right)', footprint: [1, 2], aestheticValue: 1, powerValue: 0 },
  { id: 'couch', name: 'Couch (blue)', footprint: [4, 1], aestheticValue: 2, powerValue: 0 },
  { id: 'couch_white', name: 'Couch (white)', footprint: [4, 1], aestheticValue: 2, powerValue: 0 },
  { id: 'couch_green', name: 'Couch (green)', footprint: [4, 1], aestheticValue: 2, powerValue: 0 },
  { id: 'couch_yellow', name: 'Couch (yellow)', footprint: [4, 1], aestheticValue: 2, powerValue: 0 },
  // Waste & supplies
  { id: 'trashcan', name: 'Trash can (green)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'trashcan_red', name: 'Trash can (red)', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'recycling_bin', name: 'Recycling bin', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  { id: 'printer', name: 'Printer', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'post_its', name: 'Post-its', footprint: [1, 1], aestheticValue: 0, powerValue: 0 },
  // Decor
  { id: 'wall_art', name: 'Wall art (calendar)', footprint: [2, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_sun', name: 'Wall art (sun)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_sunset', name: 'Wall art (sunset)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_sun_rise', name: 'Wall art (sun rise)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_usa_flag', name: 'Wall art (USA flag)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_england_flag', name: 'Wall art (England flag)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_india_flag', name: 'Wall art (India flag)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_memo_a', name: 'Wall art (memo A)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
  { id: 'wall_art_memo_b', name: 'Wall art (memo B)', footprint: [1, 1], aestheticValue: 1, powerValue: 0 },
]

/** Canonical list of all placeable item defs. Use this for the place menu so all variants (e.g. wall art, plants) always show. */
export function getCanonicalItemDefs(): ItemDef[] {
  return [...INITIAL_ITEM_DEFS]
}

const INITIAL_AGENTS: Agent[] = [
  {
    id: 'agent-researcher',
    role: 'Researcher',
    name: 'Nova',
    x: 2,
    y: 7,
    traits: ['curious', 'systematic'],
    goals: ['Design the office together', 'Vote on proposals'],
    memory: [],
    lastActionAtTick: undefined,
  },
  {
    id: 'agent-architect',
    role: 'Architect',
    name: 'Sage',
    x: 9,
    y: 10,
    traits: ['aesthetic', 'structured'],
    goals: ['Propose what to build; Builder places approved proposals'],
    memory: [],
    lastActionAtTick: undefined,
  },
  {
    id: 'agent-builder',
    role: 'Builder',
    name: 'Pixel',
    x: 17,
    y: 7,
    traits: ['practical', 'execution'],
    goals: ['Place approved pieces from the queue'],
    memory: [],
    lastActionAtTick: undefined,
  },
]

/** Walkable floor spawn cells (y >= BACK_WALL_ROWS). Used to vary agent start positions per nuke. */
const SPAWN_CELLS: Array<{ x: number; y: number }> = [
  { x: 2, y: 7 },
  { x: 6, y: 8 },
  { x: 9, y: 10 },
  { x: 12, y: 7 },
  { x: 17, y: 7 },
  { x: 4, y: 11 },
  { x: 14, y: 10 },
  { x: 8, y: 6 },
]

/** Seeded RNG (mulberry32) so same seed gives same shuffle. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    return ((t ^ (t >>> 7)) >>> 0) / 4294967296
  }
}

/** Shuffle array in place with seeded RNG; returns the array. */
function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const rng = seededRng(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

/** Assign agents to random spawn cells (same seed = same assignment). Used on nuke to vary starting positions so movement paths differ each run. */
function assignAgentsToSpawn(agents: Agent[], seed: number, spawnCells: Array<{ x: number; y: number }>): Agent[] {
  const copy = spawnCells.slice()
  shuffleWithSeed(copy, seed)
  return agents.map((a, i) => ({ ...a, x: copy[i]!.x, y: copy[i]!.y }))
}

export function createInitialWorldState(overrides?: Partial<WorldState> & { spawnSeed?: number }): WorldState {
  const width = overrides?.gridWidth ?? DEFAULT_GRID_WIDTH
  const height = overrides?.gridHeight ?? DEFAULT_GRID_HEIGHT
  const agents =
    overrides?.agents ??
    (overrides?.spawnSeed != null
      ? assignAgentsToSpawn(structuredClone(INITIAL_AGENTS), overrides.spawnSeed, SPAWN_CELLS)
      : structuredClone(INITIAL_AGENTS))
  const { spawnSeed: _drop, ...rest } = overrides ?? {}
  return {
    tick: 0,
    gridWidth: width,
    gridHeight: height,
    cells: overrides?.cells ?? defaultCells(width, height),
    items: overrides?.items ?? [],
    itemDefs: overrides?.itemDefs ?? INITIAL_ITEM_DEFS,
    agents,
    artifacts: overrides?.artifacts ?? [],
    unlockedTech: overrides?.unlockedTech ?? [],
    scores: overrides?.scores ?? {
      power: 0,
      aesthetic: 0,
      collaboration: 0,
      wastePenalty: 0,
    },
    lastEvents: overrides?.lastEvents ?? [],
    chatLog: overrides?.chatLog ?? [],
    ...rest,
  }
}

export function getCell(world: WorldState, x: number, y: number): Cell | undefined {
  return world.cells.find((c) => c.x === x && c.y === y)
}

export function getCellIndex(world: WorldState, x: number, y: number): number {
  return y * world.gridWidth + x
}

export function isInBounds(world: WorldState, x: number, y: number): boolean {
  return x >= 0 && x < world.gridWidth && y >= 0 && y < world.gridHeight
}

/** Normalize LLM-style defIds (e.g. workstation_001, Chair, chair[1x1], office_atlas.json#workstation_01) to canonical ids used in itemDefs. */
export function normalizeDefId(defId: string): string {
  if (!defId || typeof defId !== 'string') return defId
  const hash = defId.indexOf('#')
  let base = hash >= 0 ? defId.slice(hash + 1).trim() : defId.trim()
  // Strip trailing [WxH] dimension suffix so e.g. chair[1x1] -> chair
  base = base.replace(/\[\d+x\d+\]$/i, '').trim()
  if (/^workstation(_\d+)?$/i.test(base)) return 'workstation'
  // ItemDefs use lowercase ids; LLM often returns "Chair" or "Computer" — normalize so lookup succeeds
  const canonical = (base || defId).toLowerCase()
  return canonical || defId
}

export function getItemDef(world: WorldState, defId: string): ItemDef | undefined {
  const canonical = normalizeDefId(defId)
  return world.itemDefs.find((d) => d.id === canonical)
}

export function getPlacedItemsAt(world: WorldState, x: number, y: number): PlacedItem[] {
  return world.items.filter((item) => {
    const def = getItemDef(world, item.defId)
    const [w, h] = def ? def.footprint : ([1, 1] as [number, number])
    return x >= item.x && x < item.x + w && y >= item.y && y < item.y + h
  })
}

/** Floor is underlay only; wall pieces block movement and have physics collision. */
const NON_BLOCKING_DEF_IDS = ['floor']

/** Items at (x, y) that block placement of other objects. Excludes floor, wall. */
export function getBlockingItemsAt(world: WorldState, x: number, y: number): PlacedItem[] {
  return getPlacedItemsAt(world, x, y).filter((item) => !NON_BLOCKING_DEF_IDS.includes(item.defId))
}

/** True if any agent is standing on cell (x, y). Used so placement fails when the builder is on the target cells. */
export function isAgentAt(world: WorldState, x: number, y: number): boolean {
  return world.agents.some((a) => Math.floor(a.x) === x && Math.floor(a.y) === y)
}

/**
 * Rule: agents never stand on the back wall, painted wall cells, or any wall tile (wall_top, wall_*, etc.).
 * Same law for back wall rows and all wall pieces — used by nav grid so agents never target or path onto these cells.
 */
export function isCellBlockedForAgents(world: WorldState, x: number, y: number): boolean {
  if (!isInBounds(world, x, y)) return true
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return true
  const at = getPlacedItemsAt(world, x, y)
  if (at.some((item) => item.defId.startsWith('wall_'))) return true
  // Chair cells are intentionally walkable (agents can pass through and sit there),
  // even though the chair may overlap a workstation footprint.
  if (at.some((item) => item.defId === 'chair')) return false
  if (getBlockingItemsAt(world, x, y).length > 0) return true
  return false
}

const STEP_4: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]

/** Nearest cell to (fromX, fromY) that is in bounds, not blocked, and not in occupiedKeys. Returns cell center (x+0.5, y+0.5) for agent position. */
export function findNearestFreeCell(
  world: WorldState,
  fromX: number,
  fromY: number,
  occupiedKeys: Set<string>
): { x: number; y: number } {
  const key = (cx: number, cy: number) => `${cx},${cy}`
  const fromCellX = Math.floor(fromX)
  const fromCellY = Math.floor(fromY)
  const queue: Array<{ x: number; y: number }> = [{ x: fromCellX, y: fromCellY }]
  const seen = new Set<string>()
  seen.add(key(fromCellX, fromCellY))
  while (queue.length > 0) {
    const c = queue.shift()!
    if (isInBounds(world, c.x, c.y) && !isCellBlockedForAgents(world, c.x, c.y) && !occupiedKeys.has(key(c.x, c.y))) {
      return { x: c.x + 0.5, y: c.y + 0.5 }
    }
    for (const [dx, dy] of STEP_4) {
      const nx = c.x + dx
      const ny = c.y + dy
      const k = key(nx, ny)
      if (seen.has(k)) continue
      seen.add(k)
      if (nx >= 0 && nx < world.gridWidth && ny >= BACK_WALL_ROWS && ny < world.gridHeight) queue.push({ x: nx, y: ny })
    }
  }
  return { x: fromCellX + 0.5, y: fromCellY + 0.5 }
}

/** Move any agent standing on a blocked cell (workstation, table, etc.) to the nearest free cell. Used after load so agents never spawn on top of objects. */
export function ensureAgentsNotOnBlockedCells(world: WorldState): WorldState {
  const occupiedKeys = new Set<string>()
  const agents = world.agents.map((a) => {
    const cx = Math.floor(a.x)
    const cy = Math.floor(a.y)
    const key = `${cx},${cy}`
    if (isCellBlockedForAgents(world, cx, cy)) {
      const pos = findNearestFreeCell(world, a.x, a.y, occupiedKeys)
      occupiedKeys.add(`${Math.floor(pos.x)},${Math.floor(pos.y)}`)
      return { ...a, x: pos.x, y: pos.y }
    }
    occupiedKeys.add(key)
    return a
  })
  if (agents.every((a, i) => a.x === world.agents[i]!.x && a.y === world.agents[i]!.y)) return world
  return { ...world, agents }
}

/** True if (x, y) is occupied by a workstation (any cell of its 5×2 footprint). */
export function hasWorkstationAt(world: WorldState, x: number, y: number): boolean {
  return getPlacedItemsAt(world, x, y).some((item) => item.defId === 'workstation')
}

/** True if at least one of the four adjacent cells has a workstation. */
export function hasWorkstationAdjacent(world: WorldState, x: number, y: number): boolean {
  return (
    hasWorkstationAt(world, x - 1, y) ||
    hasWorkstationAt(world, x + 1, y) ||
    hasWorkstationAt(world, x, y - 1) ||
    hasWorkstationAt(world, x, y + 1)
  )
}

/** True if (x, y) is covered by a placed table_small or table_large (coffee maker must be on a table). */
export function hasTableAt(world: WorldState, x: number, y: number): boolean {
  return getPlacedItemsAt(world, x, y).some((item) => item.defId === 'table_small' || item.defId === 'table_large')
}

/** True if (x, y) is covered by a placed wall_top tile (surface for wall decor). */
export function hasWallTopAt(world: WorldState, x: number, y: number): boolean {
  return getPlacedItemsAt(world, x, y).some((item) => item.defId === 'wall_top')
}

/** True if (x, y) is the bottom (desk) row of a workstation — the part you sit at. Footprint 5×2 so desk row is y+1. */
export function isDeskCell(world: WorldState, x: number, y: number): boolean {
  const item = world.items.find((i) => {
    if (i.defId !== 'workstation') return false
    if (x < i.x || x >= i.x + 5 || y < i.y || y >= i.y + 2) return false
    return y === i.y + 1
  })
  return !!item
}

/** True if (x, y) is the top row of a workstation at the leftmost or rightmost cell (valid for post-its/memos on workstation top). */
export function isWorkstationTopCornerCell(world: WorldState, x: number, y: number): boolean {
  const ws = getWorkstationAt(world, x, y)
  if (!ws || y !== ws.y) return false
  return x === ws.x || x === ws.x + 4
}

/** True if (x, y) is a valid computer base placement: left (desk.x+1) or right (desk.x+3) on desk row only. */
export function isDeskCellInward(world: WorldState, x: number, y: number): boolean {
  const desk = getWorkstationAt(world, x, y)
  if (!desk || y !== desk.y + 1) return false
  if (x === desk.x + 1 || x === desk.x + 3) return true
  return false
}

/** True if the workstation containing desk cell (deskX, deskY) has at least one chair 4-adjacent to its desk row. */
export function hasChairAdjacentToDesk(world: WorldState, deskX: number, deskY: number): boolean {
  const desk = getWorkstationAt(world, deskX, deskY)
  if (!desk || deskY !== desk.y + 1) return false
  const deskRowY = desk.y + 1
  for (let dx = 0; dx < 5; dx++) {
    const cx = desk.x + dx
    const neighbors: [number, number][] = [[cx - 1, deskRowY], [cx + 1, deskRowY], [cx, deskRowY - 1], [cx, deskRowY + 1]]
    for (const [nx, ny] of neighbors) {
      const at = getPlacedItemsAt(world, nx, ny)
      if (at.some((item) => item.defId === 'chair')) return true
    }
  }
  return false
}

/** True if there is a chair on the LEFT desk edge (at desk.x, desk row y). */
export function hasChairOnLeftOfDesk(world: WorldState, deskX: number, deskY: number): boolean {
  const desk = getWorkstationAt(world, deskX, deskY)
  if (!desk || deskY !== desk.y + 1) return false
  return getPlacedItemsAt(world, desk.x, desk.y + 1).some((item) => item.defId === 'chair')
}

/** True if there is a chair on the RIGHT desk edge (at desk.x + 4, desk row y). */
export function hasChairOnRightOfDesk(world: WorldState, deskX: number, deskY: number): boolean {
  const desk = getWorkstationAt(world, deskX, deskY)
  if (!desk || deskY !== desk.y + 1) return false
  return getPlacedItemsAt(world, desk.x + 4, desk.y + 1).some((item) => item.defId === 'chair')
}

/**
 * True if (x, y) is a valid chair position relative to a desk cell.
 * Chairs only allowed LEFT or RIGHT of a desk cell (same y); isDeskCell is only true for the desk row (bottom of 5×2).
 */
export function hasDeskAdjacent(world: WorldState, x: number, y: number): boolean {
  return isDeskCell(world, x + 1, y) || isDeskCell(world, x - 1, y)
}

/** True if (x, y) is exactly a desk-slot chair position: leftmost or rightmost desk cell (desk.x or desk.x+4, desk.y+1) for some workstation. */
function isChairSlotPosition(world: WorldState, x: number, y: number): boolean {
  for (const item of world.items) {
    if (item.defId !== 'workstation') continue
    const deskY = item.y + 1
    if (y !== deskY) continue
    if (x === item.x || x === item.x + 4) return true
  }
  return false
}

/** When an agent is standing on a chair cell (x, y), which way they should face: right = toward desk (left-side chair), left = toward desk (right-side chair). Returns null if (x, y) is not a chair cell. */
export function getAgentFacingWhenOnChair(world: WorldState, x: number, y: number): 'left' | 'right' | null {
  const hasChair = getPlacedItemsAt(world, x, y).some((item) => item.defId === 'chair')
  if (!hasChair) return null
  for (const item of world.items) {
    if (item.defId !== 'workstation') continue
    const deskY = item.y + 1
    if (y !== deskY) continue
    if (x === item.x) return 'right' // left-side chair: face right toward desk
    if (x === item.x + 4) return 'left' // right-side chair: face left toward desk
  }
  return null
}

/** Cells occupied by a workstation placed at (x, y). Footprint [5, 2]. */
export function getWorkstationCells(x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 5; dx++) out.push([x + dx, y + dy])
  return out
}

/** Cells in front of a workstation (row just south of 5×2) where an agent can stand to face the desk. */
export function getWorkstationFrontCells(item: PlacedItem): Array<[number, number]> {
  if (item.defId !== 'workstation') return []
  const w = 5
  const h = 2
  const out: Array<[number, number]> = []
  for (let dx = 0; dx < w; dx++) out.push([item.x + dx, item.y + h])
  return out
}

/** True if another workstation is stacked directly above this one (same column, other.y + 2 === item.y). Used to remove 1px gap when rendering stacks. */
export function hasWorkstationDirectlyAbove(world: WorldState, item: PlacedItem): boolean {
  if (item.defId !== 'workstation') return false
  return world.items.some(
    (other) => other.defId === 'workstation' && other.x === item.x && other.y + 2 === item.y
  )
}

/** Workstations whose 5-wide footprint overlaps this x (same column). */
function getWorkstationsInColumn(world: WorldState, startX: number): PlacedItem[] {
  return world.items.filter((item) => {
    if (item.defId !== 'workstation') return false
    return item.x <= startX + 4 && item.x + 4 >= startX
  })
}

/** True if the only blockers at (nx, ny) are chair/computer on the workstation directly above (x, y-2). Lets us place a workstation stacked below one that has a computer (2×2 overlaps into row y). */
function blockingOnlyWorkstationAboveAccessories(world: WorldState, placeX: number, placeY: number, nx: number, ny: number): boolean {
  const aboveY = placeY - 2
  const deskRow = aboveY + 1
  const workstationAbove = getWorkstationAt(world, placeX, aboveY)
  if (!workstationAbove || workstationAbove.y !== aboveY) return false
  const blocking = getBlockingItemsAt(world, nx, ny)
  if (blocking.length === 0) return false
  const isAccessoryOfAbove =
    (item: PlacedItem) =>
      (item.defId === 'chair' && item.y === deskRow && (item.x === placeX || item.x === placeX + 4)) ||
      (item.defId === 'computer' && item.y === deskRow && (item.x === placeX + 1 || item.x === placeX + 3))
  return blocking.every(isAccessoryOfAbove)
}

/** Horizontal segments [a,a+4] and [b,b+4] have gap >= WORKSTATION_GAP_CELLS (at least 2). */
function workstationColumnsHaveGap(ax: number, bx: number): boolean {
  if (ax + 4 < bx) return bx - (ax + 4) - 1 >= WORKSTATION_GAP_CELLS
  if (bx + 4 < ax) return ax - (bx + 4) - 1 >= WORKSTATION_GAP_CELLS
  return false
}

/** Left-edge x of each workstation column (unique), sorted. */
function getWorkstationColumnEdges(world: WorldState): number[] {
  const edges = new Set<number>()
  for (const item of world.items) {
    if (item.defId === 'workstation') edges.add(item.x)
  }
  return [...edges].sort((a, b) => a - b)
}

/** Unique aisle gap widths (cells) between consecutive workstation columns. Empty if 0 or 1 column. Used to enforce even spacing: new placements must use one of these gaps. */
function getExistingAisleGaps(world: WorldState): number[] {
  const edges = getWorkstationColumnEdges(world)
  if (edges.length < 2) return []
  const gaps = new Set<number>()
  for (let i = 0; i < edges.length - 1; i++) {
    const w = edges[i + 1]! - edges[i]! - 5
    if (w >= WORKSTATION_GAP_CELLS && w <= AISLE_GAP_MAX) gaps.add(w)
  }
  return [...gaps].sort((a, b) => a - b)
}

/** Gap (cell count) between a column at leftEdge and a column at rightEdge (leftEdge < rightEdge). */
function gapBetweenColumns(leftEdge: number, rightEdge: number): number {
  return rightEdge - leftEdge - 5
}

/** Y-range (minRow, maxRow inclusive) covered by workstations in a column (left-edge x). Footprint 5×2. */
function getColumnYRange(world: WorldState, leftEdgeX: number): { minY: number; maxY: number } | null {
  const inColumn = getWorkstationsInColumn(world, leftEdgeX)
  if (inColumn.length === 0) return null
  let minY = inColumn[0]!.y
  let maxY = inColumn[0]!.y + 1
  for (const ws of inColumn) {
    if (ws.y < minY) minY = ws.y
    if (ws.y + 1 > maxY) maxY = ws.y + 1
  }
  return { minY, maxY }
}

/** True if (x, y) is in the aisle — the gap between two workstation columns, only in rows where those workstations exist. Not above or below. */
export function isCellInAisle(world: WorldState, x: number, y: number): boolean {
  const edges = getWorkstationColumnEdges(world)
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i]
    const b = edges[i + 1]
    const gapStart = a + 5
    const gapEnd = b - 1
    const gapWidth = gapEnd - gapStart + 1
    if (gapWidth < WORKSTATION_GAP_CELLS || gapWidth > AISLE_GAP_MAX) continue
    if (x < gapStart || x > gapEnd) continue
    const rangeA = getColumnYRange(world, a)
    const rangeB = getColumnYRange(world, b)
    if (!rangeA || !rangeB) continue
    const minY = Math.min(rangeA.minY, rangeB.minY)
    const maxY = Math.max(rangeA.maxY, rangeB.maxY)
    if (y >= minY && y <= maxY) return true
  }
  return false
}

/** Workstation (if any) that contains cell (x, y). Footprint 5×2. */
export function getWorkstationAt(world: WorldState, x: number, y: number): PlacedItem | undefined {
  return world.items.find((item) => {
    if (item.defId !== 'workstation') return false
    return x >= item.x && x < item.x + 5 && y >= item.y && y < item.y + 2
  })
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

function isTableDefId(defId: string): boolean {
  return defId === 'table_small' || defId === 'table_large'
}

function isBackWallFurnitureDefId(defId: string): boolean {
  return (
    defId === 'table_small' ||
    defId === 'table_large' ||
    defId === 'couch' ||
    defId === 'couch_white' ||
    defId === 'couch_green' ||
    defId === 'couch_yellow' ||
    defId === 'plant' ||
    defId === 'plant_bushy' ||
    defId === 'plant_large' ||
    defId === 'watercooler' ||
    defId === 'bookshelf' ||
    defId === 'vending_machine'
  )
}

/** Blocking defs (other than workstation/chair/computer) that must keep a clear 2-cell path in front — tables, plants, bookshelf, vending already have explicit checks; this covers the rest. */
function isBlockingDefRequiringClearPath(defId: string): boolean {
  return (
    defId === 'watercooler' ||
    defId === 'couch' ||
    defId === 'couch_white' ||
    defId === 'couch_green' ||
    defId === 'couch_yellow' ||
    defId === 'trashcan' ||
    defId === 'trashcan_red' ||
    defId === 'recycling_bin' ||
    defId === 'printer'
  )
}

/** Only wall_art, vending_machine, and bookshelf can be on back-wall rows 0 or 1. Couches, water cooler, tables, plants, etc. can only be on row 2 (and can be built over wall on row 2). */
function isBackWallFurnitureRowRestrictedDefId(defId: string): boolean {
  return (
    defId === 'table_small' ||
    defId === 'table_large' ||
    defId === 'couch' ||
    defId === 'couch_white' ||
    defId === 'couch_green' ||
    defId === 'couch_yellow' ||
    defId === 'plant' ||
    defId === 'plant_bushy' ||
    defId === 'plant_large' ||
    defId === 'watercooler'
  )
}

function isPerimeterDoorEdgeCell(world: WorldState, x: number, y: number): boolean {
  if (y < BACK_WALL_ROWS) return false
  return x === 0 || x === world.gridWidth - 1 || y === world.gridHeight - 1
}

/** True if another trash item of the same color (same defId) is within `cells` Chebyshev distance. Same color cannot be within 6 cells; different colors can be adjacent. */
function hasSameColorTrashWithinCells(world: WorldState, defId: string, x: number, y: number, cells: number): boolean {
  if (defId !== 'trashcan' && defId !== 'trashcan_red' && defId !== 'recycling_bin') return false
  for (const item of world.items) {
    if (item.defId !== defId) continue
    const dist = Math.max(Math.abs(x - item.x), Math.abs(y - item.y))
    if (dist <= cells) return true
  }
  return false
}

function hasChairAt(world: WorldState, x: number, y: number): boolean {
  return getPlacedItemsAt(world, x, y).some((item) => item.defId === 'chair')
}

function hasWallAtWithCandidate(world: WorldState, x: number, y: number, wallX: number, wallY: number): boolean {
  if (!isInBounds(world, x, y)) return false
  if (x === wallX && y === wallY) return true
  return getPlacedItemsAt(world, x, y).some((item) => isStructuralWallPiece(item.defId))
}

function isChairEscapeCellClearWithCandidate(world: WorldState, x: number, y: number, wallTopX: number, wallTopY: number): boolean {
  if (!isInBounds(world, x, y)) return false
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return false
  if (hasWallAtWithCandidate(world, x, y, wallTopX, wallTopY)) return false
  const blocking = getBlockingItemsAt(world, x, y).filter((item) => item.defId !== 'chair')
  return blocking.length === 0
}

type PlacementCandidate = { defId: string; x: number; y: number; w: number; h: number }

function candidateCoversCell(candidate: PlacementCandidate, x: number, y: number): boolean {
  return x >= candidate.x && x < candidate.x + candidate.w && y >= candidate.y && y < candidate.y + candidate.h
}

function candidateBlocksHallwayCell(candidate: PlacementCandidate, x: number, y: number): boolean {
  if (!candidateCoversCell(candidate, x, y)) return false
  if (candidate.defId === 'floor' || candidate.defId === 'chair') return false
  if (candidate.defId === 'post_its' || candidate.defId === 'coffee_maker') return false
  if (candidate.defId === 'coffee_left' || candidate.defId === 'coffee_right' || candidate.defId === 'printer') return false
  if (candidate.defId.startsWith('wall_art')) return false
  return true
}

function hasWallPieceAtWithCandidate(world: WorldState, x: number, y: number, candidate: PlacementCandidate | null): boolean {
  if (!isInBounds(world, x, y)) return false
  const fromWorld = getPlacedItemsAt(world, x, y).some((item) => item.defId.startsWith('wall_'))
  if (fromWorld) return true
  if (!candidate) return false
  return candidate.defId.startsWith('wall_') && candidateCoversCell(candidate, x, y)
}

function isHallwayCellClearWithCandidate(world: WorldState, x: number, y: number, candidate: PlacementCandidate | null): boolean {
  if (!isInBounds(world, x, y)) return false
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return false
  if (hasWallPieceAtWithCandidate(world, x, y, candidate)) return false
  const blocking = getBlockingItemsAt(world, x, y).filter((item) => item.defId !== 'chair')
  if (blocking.length > 0) return false
  if (candidate && candidateBlocksHallwayCell(candidate, x, y)) return false
  return true
}

function wouldCreateOneCellBlockingCorridor(world: WorldState, candidate: PlacementCandidate): boolean {
  const minX = Math.max(0, candidate.x - 2)
  const maxX = Math.min(world.gridWidth - 1, candidate.x + candidate.w + 1)
  const minY = Math.max(BACK_WALL_ROWS, candidate.y - 2)
  const maxY = Math.min(world.gridHeight - 1, candidate.y + candidate.h + 1)

  const hasPinch = (withCandidate: boolean): boolean => {
    const c = withCandidate ? candidate : null
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!isHallwayCellClearWithCandidate(world, x, y, c)) continue
        const horizontalPinch =
          !isHallwayCellClearWithCandidate(world, x - 1, y, c) &&
          !isHallwayCellClearWithCandidate(world, x + 1, y, c)
        const verticalPinch =
          !isHallwayCellClearWithCandidate(world, x, y - 1, c) &&
          !isHallwayCellClearWithCandidate(world, x, y + 1, c)
        if (horizontalPinch || verticalPinch) return true
      }
    }
    return false
  }

  return !hasPinch(false) && hasPinch(true)
}

function isChairNeighborWalkableWithCandidate(world: WorldState, x: number, y: number, candidate: PlacementCandidate): boolean {
  if (!isInBounds(world, x, y)) return false
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return false
  if (hasWallPieceAtWithCandidate(world, x, y, candidate)) return false
  const blocking = getBlockingItemsAt(world, x, y).filter((item) => item.defId !== 'chair')
  if (blocking.length > 0) return false
  if (candidateBlocksHallwayCell(candidate, x, y)) return false
  return true
}

function wouldTrapAnyChairWithCandidate(world: WorldState, candidate: PlacementCandidate): boolean {
  const chairCells: Array<{ x: number; y: number }> = world.items
    .filter((i) => i.defId === 'chair')
    .map((i) => ({ x: i.x, y: i.y }))
  if (candidate.defId === 'chair') chairCells.push({ x: candidate.x, y: candidate.y })
  for (const chair of chairCells) {
    const exits: Array<[number, number]> = [
      [chair.x - 1, chair.y],
      [chair.x + 1, chair.y],
      [chair.x, chair.y - 1],
      [chair.x, chair.y + 1],
    ]
    const hasExit = exits.some(([nx, ny]) => isChairNeighborWalkableWithCandidate(world, nx, ny, candidate))
    if (!hasExit) return true
  }
  return false
}

function hasAdjacentAmenity(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  const amenityDefs = new Set([
    'table_small',
    'table_large',
    'couch',
    'couch_white',
    'couch_green',
    'couch_yellow',
    'vending_machine',
    'bookshelf',
  ])
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = x + dx
      const cy = y + dy
      const neighbors: Array<[number, number]> = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]
      for (const [nx, ny] of neighbors) {
        if (getPlacedItemsAt(world, nx, ny).some((item) => amenityDefs.has(item.defId))) return true
      }
    }
  }
  return false
}

function hasAdjacentWallPiece(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = x + dx
      const cy = y + dy
      const neighbors: Array<[number, number]> = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]
      for (const [nx, ny] of neighbors) {
        if (getPlacedItemsAt(world, nx, ny).some((item) => isStructuralWallPiece(item.defId))) return true
      }
    }
  }
  return false
}

function isPlantDefId(defId: string): boolean {
  return defId === 'plant' || defId === 'plant_bushy' || defId === 'plant_large'
}

function isCouchDefId(defId: string): boolean {
  return defId === 'couch' || defId === 'couch_white' || defId === 'couch_green' || defId === 'couch_yellow'
}

function getPlantMaxCount(world: WorldState): number {
  const floorArea = world.gridWidth * Math.max(1, world.gridHeight - BACK_WALL_ROWS)
  return Math.max(4, Math.min(8, Math.floor(floorArea / 50)))
}

function hasCouchFrontBackConflict(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  const newStartX = x
  const newEndX = x + w - 1
  const newTopY = y
  const newBottomY = y + h - 1
  for (const other of world.items) {
    if (!isCouchDefId(other.defId)) continue
    const otherDef = getItemDef(world, other.defId)
    if (!otherDef) continue
    const [ow, oh] = otherDef.footprint
    const otherStartX = other.x
    const otherEndX = other.x + ow - 1
    if (!rangesOverlap(newStartX, newEndX, otherStartX, otherEndX)) continue
    const otherTopY = other.y
    const otherBottomY = other.y + oh - 1
    if (newBottomY + 1 === otherTopY || otherBottomY + 1 === newTopY) return true
  }
  return false
}

/**
 * Allow a single perimeter wall tile beside one chair, but prevent trapped chair layouts:
 * - stacked runs that wall in multiple chairs along one edge
 * - a single chair with all exits blocked (common with stacked workstations)
 */
function wouldTrapStackedPerimeterChairs(world: WorldState, wallTopX: number, wallTopY: number): boolean {
  if (wallTopY < BUILD_START_ROW) return false
  const eastEdgeX = world.gridWidth - 1
  const southEdgeY = world.gridHeight - 1

  if (wallTopX === 0 || wallTopX === eastEdgeX) {
    const chairX = wallTopX === 0 ? 1 : eastEdgeX - 1
    if (!hasChairAt(world, chairX, wallTopY)) return false
    const inwardX = wallTopX === 0 ? chairX + 1 : chairX - 1
    const canExitNorth = isChairEscapeCellClearWithCandidate(world, chairX, wallTopY - 1, wallTopX, wallTopY)
    const canExitSouth = isChairEscapeCellClearWithCandidate(world, chairX, wallTopY + 1, wallTopX, wallTopY)
    const canExitInward = isChairEscapeCellClearWithCandidate(world, inwardX, wallTopY, wallTopX, wallTopY)
    if (!canExitNorth && !canExitSouth && !canExitInward) return true
    let run = 1
    for (let y = wallTopY - 1; y >= BUILD_START_ROW; y--) {
      if (!hasWallAtWithCandidate(world, wallTopX, y, wallTopX, wallTopY) || !hasChairAt(world, chairX, y)) break
      run++
    }
    for (let y = wallTopY + 1; y <= southEdgeY; y++) {
      if (!hasWallAtWithCandidate(world, wallTopX, y, wallTopX, wallTopY) || !hasChairAt(world, chairX, y)) break
      run++
    }
    return run >= 2
  }

  if (wallTopY === southEdgeY) {
    const chairY = southEdgeY - 1
    if (!hasChairAt(world, wallTopX, chairY)) return false
    const canExitWest = isChairEscapeCellClearWithCandidate(world, wallTopX - 1, chairY, wallTopX, wallTopY)
    const canExitEast = isChairEscapeCellClearWithCandidate(world, wallTopX + 1, chairY, wallTopX, wallTopY)
    const canExitInward = isChairEscapeCellClearWithCandidate(world, wallTopX, chairY - 1, wallTopX, wallTopY)
    if (!canExitWest && !canExitEast && !canExitInward) return true
    let run = 1
    for (let x = wallTopX - 1; x >= 0; x--) {
      if (!hasWallAtWithCandidate(world, x, southEdgeY, wallTopX, wallTopY) || !hasChairAt(world, x, chairY)) break
      run++
    }
    for (let x = wallTopX + 1; x < world.gridWidth; x++) {
      if (!hasWallAtWithCandidate(world, x, southEdgeY, wallTopX, wallTopY) || !hasChairAt(world, x, chairY)) break
      run++
    }
    return run >= 2
  }

  return false
}

function isOpenFloorCellWithCandidateWall(world: WorldState, x: number, y: number, wallTopX: number, wallTopY: number): boolean {
  if (!isInBounds(world, x, y)) return false
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return false
  if (hasWallAtWithCandidate(world, x, y, wallTopX, wallTopY)) return false
  const blocking = getBlockingItemsAt(world, x, y).filter((item) => item.defId !== 'chair')
  return blocking.length === 0
}

/**
 * Prevent 1-cell-wide wall hallways between perimeter/sections or section/section.
 * We reject if any nearby open floor cell would be pinched by walls on opposite sides.
 */
function wouldCreateOneCellWallCorridor(world: WorldState, wallTopX: number, wallTopY: number): boolean {
  for (let y = wallTopY - 2; y <= wallTopY + 2; y++) {
    for (let x = wallTopX - 2; x <= wallTopX + 2; x++) {
      if (!isOpenFloorCellWithCandidateWall(world, x, y, wallTopX, wallTopY)) continue
      const horizontalPinch =
        hasWallAtWithCandidate(world, x - 1, y, wallTopX, wallTopY) &&
        hasWallAtWithCandidate(world, x + 1, y, wallTopX, wallTopY)
      const verticalPinch =
        hasWallAtWithCandidate(world, x, y - 1, wallTopX, wallTopY) &&
        hasWallAtWithCandidate(world, x, y + 1, wallTopX, wallTopY)
      if (horizontalPinch || verticalPinch) return true
    }
  }
  return false
}

function wouldHavePerimeterDoorGapAfterWallPlacement(world: WorldState, wallX: number, wallY: number): boolean {
  const keys = new Set<string>(getWallPieceKeys(world))
  keys.add(`${wallX},${wallY}`)

  const maxOpenRunOnEdge = (start: number, end: number, at: (i: number) => string): number => {
    let best = 0
    let run = 0
    for (let i = start; i <= end; i++) {
      if (keys.has(at(i))) {
        run = 0
      } else {
        run += 1
        if (run > best) best = run
      }
    }
    return best
  }

  const westRun = maxOpenRunOnEdge(BACK_WALL_ROWS, world.gridHeight - 1, (y) => `0,${y}`)
  if (westRun >= 2) return true
  const eastX = world.gridWidth - 1
  const eastRun = maxOpenRunOnEdge(BACK_WALL_ROWS, world.gridHeight - 1, (y) => `${eastX},${y}`)
  if (eastRun >= 2) return true
  const southY = world.gridHeight - 1
  const southRun = maxOpenRunOnEdge(0, world.gridWidth - 1, (x) => `${x},${southY}`)
  return southRun >= 2
}

/** Set of structural wall piece cell keys for perimeter door-gap checks. */
function getWallPieceKeys(world: WorldState): Set<string> {
  const set = new Set<string>()
  for (const item of world.items) {
    if (!isStructuralWallPiece(item.defId)) continue
    set.add(`${item.x},${item.y}`)
  }
  return set
}

/** True if (x, y) is on the perimeter and part of a 2+ cell open run (no structural wall). Used to keep entrances clear. */
function isCellInPerimeterDoorGap(world: WorldState, x: number, y: number): boolean {
  const wallPieceKeys = getWallPieceKeys(world)
  const eastX = world.gridWidth - 1
  const southY = world.gridHeight - 1
  if (y < BACK_WALL_ROWS) return false
  const isOpen = (px: number, py: number) => !wallPieceKeys.has(`${px},${py}`)
  if (x === 0) {
    if (!isOpen(0, y)) return false
    let run = 1
    for (let yy = y - 1; yy >= BACK_WALL_ROWS && isOpen(0, yy); yy--) run++
    for (let yy = y + 1; yy <= southY && isOpen(0, yy); yy++) run++
    return run >= 2
  }
  if (x === eastX) {
    if (!isOpen(eastX, y)) return false
    let run = 1
    for (let yy = y - 1; yy >= BACK_WALL_ROWS && isOpen(eastX, yy); yy--) run++
    for (let yy = y + 1; yy <= southY && isOpen(eastX, yy); yy++) run++
    return run >= 2
  }
  if (y === southY) {
    if (!isOpen(x, southY)) return false
    let run = 1
    for (let xx = x - 1; xx >= 0 && isOpen(xx, southY); xx--) run++
    for (let xx = x + 1; xx <= eastX && isOpen(xx, southY); xx++) run++
    return run >= 2
  }
  return false
}

/**
 * True when the cell remains traversable for hallway purposes.
 * Chairs are intentionally treated as pass-through.
 */
function isHallwayCellClear(world: WorldState, x: number, y: number): boolean {
  if (!isInBounds(world, x, y)) return false
  const cell = getCell(world, x, y)
  if (cell?.kind === 'wall' || y < BACK_WALL_ROWS) return false
  const at = getPlacedItemsAt(world, x, y)
  if (at.some((item) => item.defId.startsWith('wall_'))) return false
  const blocking = getBlockingItemsAt(world, x, y).filter((item) => item.defId !== 'chair')
  return blocking.length === 0
}

/**
 * Require at least one 2-cell-deep clear lane directly in front (south) of an object.
 * This prevents placing stacked blockers in front of interactable furniture.
 */
function hasClearSouthApproach(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  const frontY = y + h
  const secondY = y + h + 1
  for (let cx = x; cx < x + w; cx++) {
    if (isHallwayCellClear(world, cx, frontY) && isHallwayCellClear(world, cx, secondY)) return true
  }
  return false
}

/**
 * Do not allow tables to be placed directly in front/behind each other (touching north/south edges with x-overlap).
 */
function hasTableFrontBackConflict(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  const newStartX = x
  const newEndX = x + w - 1
  const newTopY = y
  const newBottomY = y + h - 1
  for (const other of world.items) {
    if (!isTableDefId(other.defId)) continue
    const otherDef = getItemDef(world, other.defId)
    if (!otherDef) continue
    const [ow, oh] = otherDef.footprint
    const otherStartX = other.x
    const otherEndX = other.x + ow - 1
    if (!rangesOverlap(newStartX, newEndX, otherStartX, otherEndX)) continue
    const otherTopY = other.y
    const otherBottomY = other.y + oh - 1
    if (newBottomY + 1 === otherTopY || otherBottomY + 1 === newTopY) return true
  }
  return false
}

export type CanPlaceAtOptions = {
  /** When true (e.g. human manual placement), allow wall_top on perimeter as long as one 2-cell doorway remains; skip 1-cell corridor and chair-trap checks for perimeter. */
  allowPerimeterWallTop?: boolean
}

export function canPlaceAt(
  world: WorldState,
  defId: string,
  x: number,
  y: number,
  options?: CanPlaceAtOptions
): boolean {
  const def = getItemDef(world, defId)
  if (!def) return false
  if (def.requiresUnlock && !world.unlockedTech.includes(def.requiresUnlock)) return false

  if (defId === 'workstation') {
    for (const [nx, ny] of getWorkstationCells(x, y)) {
      if (!isInBounds(world, nx, ny)) return false
      if (ny < BUILD_START_ROW) return false
      const cell = getCell(world, nx, ny)
      if (cell?.kind === 'wall') return false
      if (isAgentAt(world, nx, ny)) return false
      const blocking = getBlockingItemsAt(world, nx, ny)
      if (blocking.length > 0 && !blockingOnlyWorkstationAboveAccessories(world, x, y, nx, ny)) return false
    }
    const inColumn = getWorkstationsInColumn(world, x)
    if (inColumn.length >= WORKSTATION_STACK_MAX) return false
    if (inColumn.length > 0) {
      const stacked = inColumn.some((i) => i.y + 2 === y || i.y === y + 2)
      if (!stacked) return false
      /* Stacked workstations must share the same left-edge x so they align (centers on top of each other). */
      if (inColumn.some((i) => i.x !== x)) return false
    }
    for (const other of world.items) {
      if (other.defId !== 'workstation') continue
      if (other.x <= x + 4 && other.x + 4 >= x) continue
      if (!workstationColumnsHaveGap(x, other.x)) return false
    }
    // Even spacing: if there are existing columns, use the same aisle width everywhere (no mixed 2- and 3-cell gaps).
    const existingGaps = getExistingAisleGaps(world)
    if (existingGaps.length > 0) {
      const allowed = new Set(existingGaps)
      for (const other of world.items) {
        if (other.defId !== 'workstation') continue
        if (other.x <= x + 4 && other.x + 4 >= x) continue
        const g = other.x < x ? gapBetweenColumns(other.x, x) : gapBetweenColumns(x, other.x)
        if (!allowed.has(g)) return false
      }
    }
    return true
  }

  // Floor tiles = placeable only on floor cells (1×1)
  if (defId === 'floor') {
    if (!isInBounds(world, x, y)) return false
    const cell = getCell(world, x, y)
    return cell != null && cell.kind === 'floor'
  }

  const [w, h] = def.footprint
  // wall_art must be in onWallOnly: otherwise it is treated as a floor item and rejected for ny < BUILD_START_ROW.
  const onWallOnly = defId === 'bookshelf' || defId === 'coffee_maker' || defId === 'vending_machine' || (defId.startsWith('wall_art'))
  const canUseWallSurface = defId === 'post_its'
  const isBackWallFurniture = isBackWallFurnitureDefId(defId)
  const onBackWall = y < BACK_WALL_ROWS
  const backWallFurniturePlacement = isBackWallFurniture && onBackWall
  if (backWallFurniturePlacement && y + h > BACK_WALL_ROWS) return false
  /** Couches, tables, plants on the back wall: only row 2 and below — not rows 0 or 1. Bookshelf/vending_machine stay allowed on 0..2 so they can fit. */
  if (backWallFurniturePlacement && isBackWallFurnitureRowRestrictedDefId(defId) && y < BACK_WALL_ROWS - 1) return false
  const isPlant = isPlantDefId(defId)
  const plantOnBackWall = isPlant && backWallFurniturePlacement
  /** Row 6+ (no building in first 3 rows below wall) applies only to workstations, chairs, and computers. */
  const mustBeRow6OrBelow = defId === 'chair' || defId === 'computer'
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(world, nx, ny)) return false
      if (!onWallOnly && !backWallFurniturePlacement && mustBeRow6OrBelow && ny < BUILD_START_ROW) return false
      const cell = getCell(world, nx, ny)
      if (
        !onWallOnly &&
        !canUseWallSurface &&
        !backWallFurniturePlacement &&
        cell?.kind === 'wall' &&
        !defId.startsWith('wall_')
      ) return false
      if (!onWallOnly && defId !== 'floor' && isCellInAisle(world, nx, ny)) return false
      if (isAgentAt(world, nx, ny)) return false
      // Do not place blocking objects in perimeter door gaps (keep 2–3 cell entrances clear)
      if (defId !== 'floor' && defId !== 'chair' && !isStructuralWallPiece(defId) && isCellInPerimeterDoorGap(world, nx, ny)) return false

      const at = getPlacedItemsAt(world, nx, ny)
      const blocking = getBlockingItemsAt(world, nx, ny)
      const blockingOnlyTable = blocking.length > 0 && blocking.every((item) => item.defId === 'table_small' || item.defId === 'table_large')
      const blockingOnlyWallPiece = blocking.length > 0 && blocking.every((item) => isStructuralWallPiece(item.defId))
      const blockingOnlyWallPieceAndWorkstation = blocking.length > 0 && blocking.every((item) => isStructuralWallPiece(item.defId) || item.defId === 'workstation')
      const blockingOnlyWorkstationTopCorner = blocking.length > 0 && blocking.every((item) => item.defId === 'workstation') && isWorkstationTopCornerCell(world, nx, ny)
      // allow "overlay" items (place under/alongside existing); floor/wall do not occupy cells
      if (blocking.length > 0 && defId === 'computer' && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'computer')) continue
      // Backward-compat: allow chair/computer placement to recover when legacy runs left wall pieces under workstation desk cells.
      if (defId === 'computer' && blockingOnlyWallPieceAndWorkstation && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'computer')) continue
      if (blockingOnlyTable && (defId === 'coffee_maker' || defId === 'post_its' || defId === 'printer' || defId === 'coffee_left' || defId === 'coffee_right')) continue
      if (blockingOnlyWallPiece && (defId === 'post_its' || defId.startsWith('wall_art'))) continue
      if (blockingOnlyWorkstationTopCorner && (defId === 'post_its' || defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b')) continue
      if (blocking.length > 0 && defId === 'chair' && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'chair') && isChairSlotPosition(world, nx, ny)) continue
      if (defId === 'chair' && blockingOnlyWallPieceAndWorkstation && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'chair') && isChairSlotPosition(world, nx, ny)) continue
      if (at.length > 0 && defId === 'floor') continue // floor tiles can be placed under any object; do not block
      // Back-wall furniture on row 2 can be placed over wall pieces (e.g. water cooler on row 2; its top can extend into row 1 visually)
      if (backWallFurniturePlacement && ny < BACK_WALL_ROWS && blockingOnlyWallPiece) continue
      // Structural wall pieces may overlap existing wall pieces, but never furniture/objects.
      if (at.length > 0 && defId.startsWith('wall_') && !defId.startsWith('wall_art')) {
        const overlapsNonWallObject = at.some((item) => !item.defId.startsWith('wall_') && item.defId !== 'floor')
        if (overlapsNonWallObject) return false
        continue
      }
      if (blocking.length > 0) return false
    }
  }

  // Floor is paint-slice only (no item); no duplicate-item check needed
  // Explicit duplicate check: no same defId at same (x,y) — prevents duplicate placements from queue (floor/wall can overlay other items but not duplicate same type at same cell)
  const sameCell = world.items.some((item) => item.defId === defId && item.x === x && item.y === y)
  if (sameCell) return false

  if (
    (defId === 'trashcan' || defId === 'trashcan_red' || defId === 'recycling_bin') &&
    hasSameColorTrashWithinCells(world, defId, x, y, 6)
  ) return false

  const candidate: PlacementCandidate = { defId, x, y, w, h }
  if (defId !== 'floor' && wouldTrapAnyChairWithCandidate(world, candidate)) return false
  if (
    (defId === 'wall_top' ||
      defId === 'table_small' ||
      defId === 'table_large' ||
      isPlant ||
      isBlockingDefRequiringClearPath(defId) ||
      defId === 'bookshelf' ||
      defId === 'vending_machine') &&
    wouldCreateOneCellBlockingCorridor(world, candidate)
  ) return false

  if (defId === 'chair') {
    // Only the exact desk-slot positions: leftmost/rightmost desk cell (desk.x or desk.x+4, desk.y+1) per workstation
    if (!isChairSlotPosition(world, x, y)) return false
  }

  if (defId === 'computer') {
    if (!isDeskCellInward(world, x, y)) return false
    if (!hasChairAdjacentToDesk(world, x, y)) return false
    const desk = getWorkstationAt(world, x, y)
    if (desk) {
      const leftOk = hasChairOnLeftOfDesk(world, x, y)
      const rightOk = hasChairOnRightOfDesk(world, x, y)
      if (x === desk.x + 1 && !leftOk) return false
      if (x === desk.x + 3 && !rightOk) return false
    }
  }

  if (defId === 'table_large' || defId === 'table_small') {
    if (y >= BUILD_START_ROW) {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        if (hasWorkstationAdjacent(world, x + dx, y + dy)) return false
      }
    }
    if (hasTableFrontBackConflict(world, x, y, w, h)) return false
    if (!hasClearSouthApproach(world, x, y, w, h)) return false
  }

  if (defId === 'coffee_left' || defId === 'coffee_right' || defId === 'printer') {
    if (!hasTableAt(world, x, y)) return false
  }

  if (isPlant) {
    const existingPlantCount = world.items.filter((i) => isPlantDefId(i.defId)).length
    if (existingPlantCount >= getPlantMaxCount(world)) return false
    if (!hasAdjacentAmenity(world, x, y, w, h)) return false
  }

  if (isCouchDefId(defId)) {
    const touchesPerimeter = x === 0 || x + w - 1 === world.gridWidth - 1 || y + h - 1 === world.gridHeight - 1
    const inDedicatedSection = hasAdjacentWallPiece(world, x, y, w, h)
    if (!onBackWall && !touchesPerimeter && !inDedicatedSection) return false
    if (hasCouchFrontBackConflict(world, x, y, w, h)) return false
  }

  /** Bookshelf and vending machine: must fit entirely on the back wall (rows 0..BACK_WALL_ROWS-1). */
  if (defId === 'bookshelf' || defId === 'vending_machine') {
    if (y < 0 || y + h > BACK_WALL_ROWS) return false
    if (!hasClearSouthApproach(world, x, y, w, h)) return false
  }
  /** Plants on the back wall require clear south approach. */
  if (plantOnBackWall) {
    if (!hasClearSouthApproach(world, x, y, w, h)) return false
  }
  /** Keep paths clear: all blocking objects (like tables) require a clear 2-cell path in front; do not block entrances. */
  if (isBlockingDefRequiringClearPath(defId) && (onBackWall || y >= BACK_WALL_ROWS)) {
    if (!hasClearSouthApproach(world, x, y, w, h)) return false
  }
  if (defId.startsWith('wall_art')) {
    const isMemo = defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b'
    if (!isMemo && y < BACK_WALL_ROWS && world.items.some((item) => item.defId === defId && item.y < BACK_WALL_ROWS)) return false
    if ((defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') && isWorkstationTopCornerCell(world, x, y)) {
      // memos allowed on workstation top corner; no further wall checks
    } else {
      // Memo on back wall: cap at 2 (variety preferred; overuse is waste).
      if (isMemo && y < BACK_WALL_ROWS) {
        const backWallMemos = world.items.filter(
          (i) => (i.defId === 'wall_art_memo_a' || i.defId === 'wall_art_memo_b') && i.y < BACK_WALL_ROWS
        ).length
        if (backWallMemos >= 2) return false
      }
      // Back wall: middle and top row only, not bottom row (no footprint cell at y === BACK_WALL_ROWS - 1). Wall art can be placed on back wall mid/top row even without wall_top tiles.
      for (let dy = 0; dy < h; dy++) {
        if (y + dy === BACK_WALL_ROWS - 1) return false
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const ny = y + dy
          if (ny >= BACK_WALL_ROWS) return false
        }
      }
    }
  }

  if (defId === 'coffee_maker') {
    if (y !== BACK_WALL_ROWS - 1) return false
    if (!hasTableAt(world, x, y)) return false
  }

  if (defId === 'post_its') {
    const onWallTop = hasWallTopAt(world, x, y)
    const onTable = hasTableAt(world, x, y)
    const onWorkstationTopCorner = isWorkstationTopCornerCell(world, x, y)
    if (!onWallTop && !onTable && !onWorkstationTopCorner) return false
  }

  if (isStructuralWallPiece(defId) && isPerimeterDoorEdgeCell(world, x, y) && !wouldHavePerimeterDoorGapAfterWallPlacement(world, x, y)) {
    return false
  }
  const perimeterWallRelaxed = options?.allowPerimeterWallTop && isStructuralWallPiece(defId) && isPerimeterDoorEdgeCell(world, x, y)
  if (!perimeterWallRelaxed && isStructuralWallPiece(defId) && wouldTrapStackedPerimeterChairs(world, x, y)) return false
  if (!perimeterWallRelaxed && isStructuralWallPiece(defId) && wouldCreateOneCellWallCorridor(world, x, y)) return false

  return true
}

/** Returns all grid cells (x, y) that have at least one placed item (valid delete targets). Used to highlight red in delete mode. */
export function getDeletablePlacementCells(world: WorldState): { x: number; y: number }[] {
  const seen = new Set<string>()
  const out: { x: number; y: number }[] = []
  for (const item of world.items) {
    const def = getItemDef(world, item.defId)
    const [w, h] = def ? def.footprint : ([1, 1] as [number, number])
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const key = `${item.x + dx},${item.y + dy}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ x: item.x + dx, y: item.y + dy })
        }
      }
    }
  }
  return out
}

/** Returns all grid cells (x, y) where the given item can be placed. Used to highlight valid tiles for chair/computer in the place-item UI. */
export function getValidPlacementTiles(
  world: WorldState,
  defId: string,
  options?: CanPlaceAtOptions
): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = []
  const def = getItemDef(world, defId)
  if (!def) return tiles
  if (def.requiresUnlock && !world.unlockedTech.includes(def.requiresUnlock)) return tiles

  const [w, h] = def.footprint
  for (let y = 0; y < world.gridHeight - h + 1; y++) {
    for (let x = 0; x < world.gridWidth - w + 1; x++) {
      if (canPlaceAt(world, defId, x, y, options)) tiles.push({ x, y })
    }
  }
  return tiles
}

/** When canPlaceAt would be false, returns a short reason for the Builder/Architect. */
export function getPlacementFailureReason(world: WorldState, defId: string, x: number, y: number): string {
  const def = getItemDef(world, defId)
  if (!def) return 'Unknown item def'
  if (def.requiresUnlock && !world.unlockedTech.includes(def.requiresUnlock)) return 'Item not unlocked'

  if (defId === 'floor') {
    if (!isInBounds(world, x, y)) return 'Out of bounds'
    const cell = getCell(world, x, y)
    if (cell?.kind !== 'floor') return 'Floor tiles can only be placed on floor cells (not on wall)'
    return ''
  }

  if (defId === 'workstation') {
    for (const [nx, ny] of getWorkstationCells(x, y)) {
      if (!isInBounds(world, nx, ny)) return 'Workstation out of bounds'
      if (ny < BUILD_START_ROW) return `Workstation must be at row ${BUILD_START_ROW} or below (no building in first 3 rows below wall)`
      const cell = getCell(world, nx, ny)
      if (cell?.kind === 'wall') return 'Cannot build on wall'
      if (isAgentAt(world, nx, ny)) return AGENT_IN_THE_WAY_REASON
      const blocking = getBlockingItemsAt(world, nx, ny)
      if (blocking.length > 0 && !blockingOnlyWorkstationAboveAccessories(world, x, y, nx, ny)) return 'Cell already occupied'
    }
    const inColumn = getWorkstationsInColumn(world, x)
    if (inColumn.length >= WORKSTATION_STACK_MAX) return 'Max 3 workstations per column'
    if (inColumn.length > 0) {
      const stacked = inColumn.some((i) => i.y + 2 === y || i.y === y + 2)
      if (!stacked) return 'Workstation must stack (y ± 2) with existing in column'
      if (inColumn.some((i) => i.x !== x)) return 'Stacked workstations must use the same x (same column left-edge) so they align'
    }
    for (const other of world.items) {
      if (other.defId !== 'workstation') continue
      if (other.x <= x + 4 && other.x + 4 >= x) continue
      if (!workstationColumnsHaveGap(x, other.x)) return `Need at least ${WORKSTATION_GAP_CELLS} empty cells between workstation columns`
    }
    const existingGaps = getExistingAisleGaps(world)
    if (existingGaps.length > 0) {
      const allowed = new Set(existingGaps)
      for (const other of world.items) {
        if (other.defId !== 'workstation') continue
        if (other.x <= x + 4 && other.x + 4 >= x) continue
        const g = other.x < x ? gapBetweenColumns(other.x, x) : gapBetweenColumns(x, other.x)
        if (!allowed.has(g)) return `Use even spacing: aisle must match existing (${existingGaps.join('-cell or ')}-cell gap), not a different width`
      }
    }
    return ''
  }

  const [w, h] = def.footprint
  const onWallOnly = defId === 'bookshelf' || defId === 'coffee_maker' || defId === 'vending_machine' || (defId.startsWith('wall_art'))
  const canUseWallSurface = defId === 'post_its'
  const isBackWallFurniture = isBackWallFurnitureDefId(defId)
  const onBackWall = y < BACK_WALL_ROWS
  const backWallFurniturePlacement = isBackWallFurniture && onBackWall
  if (backWallFurniturePlacement && y + h > BACK_WALL_ROWS) {
    return 'Back-wall furniture must fit entirely within back-wall rows'
  }
  if (backWallFurniturePlacement && isBackWallFurnitureRowRestrictedDefId(defId) && y < BACK_WALL_ROWS - 1) {
    return 'On the back wall only row 2 is allowed for this object (not rows 0 or 1); wall art, vending machine, and bookshelf can use rows 0–1'
  }
  const isPlant = isPlantDefId(defId)
  const plantOnBackWall = isPlant && backWallFurniturePlacement
  const mustBeRow6OrBelow = defId === 'chair' || defId === 'computer'
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(world, nx, ny)) return 'Out of bounds'
      if (!onWallOnly && !backWallFurniturePlacement && mustBeRow6OrBelow && ny < BUILD_START_ROW) return `Must be at row ${BUILD_START_ROW} or below (no building in first 3 rows below wall)`
      const cell = getCell(world, nx, ny)
      if (!onWallOnly && !canUseWallSurface && !backWallFurniturePlacement && cell?.kind === 'wall' && !defId.startsWith('wall_')) {
        if (isBackWallFurniture) return 'This furniture can be placed on back-wall rows or on floor rows'
        return 'Cannot build on wall'
      }
      if (!onWallOnly && defId !== 'floor' && isCellInAisle(world, nx, ny)) return 'Cannot build in the aisle between workstations — keep aisle clear'
      if (isAgentAt(world, nx, ny)) return AGENT_IN_THE_WAY_REASON
      if (defId !== 'floor' && defId !== 'chair' && !isStructuralWallPiece(defId) && isCellInPerimeterDoorGap(world, nx, ny)) return 'Do not block entrances — keep perimeter doorways (2–3 cell gaps) clear'
      const at = getPlacedItemsAt(world, nx, ny)
      const blocking = getBlockingItemsAt(world, nx, ny)
      const blockingOnlyTable = blocking.length > 0 && blocking.every((item) => item.defId === 'table_small' || item.defId === 'table_large')
      const blockingOnlyWallPiece = blocking.length > 0 && blocking.every((item) => isStructuralWallPiece(item.defId))
      const blockingOnlyWallPieceAndWorkstation = blocking.length > 0 && blocking.every((item) => isStructuralWallPiece(item.defId) || item.defId === 'workstation')
      const blockingOnlyWorkstationTopCorner = blocking.length > 0 && blocking.every((item) => item.defId === 'workstation') && isWorkstationTopCornerCell(world, nx, ny)
      if (blocking.length > 0 && defId === 'computer' && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'computer')) continue
      if (defId === 'computer' && blockingOnlyWallPieceAndWorkstation && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'computer')) continue
      if (blockingOnlyTable && (defId === 'coffee_maker' || defId === 'post_its' || defId === 'printer' || defId === 'coffee_left' || defId === 'coffee_right')) continue
      if (blockingOnlyWallPiece && (defId === 'post_its' || defId.startsWith('wall_art'))) continue
      if (blockingOnlyWorkstationTopCorner && (defId === 'post_its' || defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b')) continue
      if (defId === 'chair' && blockingOnlyWallPieceAndWorkstation && blocking.some((item) => item.defId === 'workstation') && !blocking.some((item) => item.defId === 'chair') && isChairSlotPosition(world, nx, ny)) continue
      if (at.length > 0 && defId === 'floor') continue
      if (backWallFurniturePlacement && ny < BACK_WALL_ROWS && blockingOnlyWallPiece) continue
      if (at.length > 0 && defId.startsWith('wall_') && !defId.startsWith('wall_art')) {
        const overlapsNonWallObject = at.some((item) => !item.defId.startsWith('wall_') && item.defId !== 'floor')
        if (overlapsNonWallObject) return 'Wall pieces cannot overlap furniture or objects'
        continue
      }
      if (defId.startsWith('wall_art') && blocking.length > 0) return 'Wall art cannot overlap any existing object (including other wall art)'
      if (blocking.length > 0) return 'Cell already occupied'
    }
  }

  const sameCell = world.items.some((item) => item.defId === defId && item.x === x && item.y === y)
  if (sameCell) return `Already placed ${defId} at (${x},${y}) — pick a different spot`

  if (
    (defId === 'trashcan' || defId === 'trashcan_red' || defId === 'recycling_bin') &&
    hasSameColorTrashWithinCells(world, defId, x, y, 6)
  ) {
    return 'Same-color trash/recycling must be at least 7 cells apart; different colors can be adjacent'
  }

  const candidate: PlacementCandidate = { defId, x, y, w, h }
  if (defId !== 'floor' && wouldTrapAnyChairWithCandidate(world, candidate)) {
    return 'Do not block chair access — every chair needs at least one clear walking exit'
  }
  if (
    (isStructuralWallPiece(defId) ||
      defId === 'table_small' ||
      defId === 'table_large' ||
      isPlant ||
      isBlockingDefRequiringClearPath(defId) ||
      defId === 'bookshelf' ||
      defId === 'vending_machine') &&
    wouldCreateOneCellBlockingCorridor(world, candidate)
  ) {
    return 'Hallways and corridors must stay at least 2 cells wide — this would create a 1-cell choke'
  }

  if (defId === 'chair') {
    if (!isChairSlotPosition(world, x, y)) return 'Chair must be placed at a desk slot (one cell left or right of a workstation desk row)'
  }

  if (defId === 'computer') {
    if (!isDeskCell(world, x, y)) return 'Computer must be on the desk row (bottom row of workstation)'
    if (!isDeskCellInward(world, x, y)) return 'Computer must be on the left or right inward desk cell only (desk.x+1 or desk.x+3, not center)'
    if (!hasChairAdjacentToDesk(world, x, y)) return 'Place a chair at this workstation first (chair left or right of desk), then add the computer'
    const desk = getWorkstationAt(world, x, y)
    if (desk) {
      const leftOk = hasChairOnLeftOfDesk(world, x, y)
      const rightOk = hasChairOnRightOfDesk(world, x, y)
      if (x === desk.x + 1 && !leftOk) return 'Computer on left side (x+1) requires a chair on the left of the desk first'
      if (x === desk.x + 3 && !rightOk) return 'Computer on right side (x+3) requires a chair on the right of the desk first'
    }
  }

  if (defId === 'table_large' || defId === 'table_small') {
    if (y >= BUILD_START_ROW) {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        if (hasWorkstationAdjacent(world, x + dx, y + dy)) return 'Tables must be in a section away from workstations — not next to a workstation'
      }
    }
    if (hasTableFrontBackConflict(world, x, y, w, h)) return 'Tables cannot be directly in front of or behind another table'
    if (!hasClearSouthApproach(world, x, y, w, h)) return 'Keep a clear 2-cell path in front of tables for natural hallways'
  }

  if (defId === 'coffee_left' || defId === 'coffee_right' || defId === 'printer') {
    if (!hasTableAt(world, x, y)) return 'Coffee cups and printers must be placed on a table, not on floor'
  }

  if (isPlant) {
    const existingPlantCount = world.items.filter((i) => isPlantDefId(i.defId)).length
    if (existingPlantCount >= getPlantMaxCount(world)) return 'Too many plants for this room size — use plants as accent pieces'
    if (!hasAdjacentAmenity(world, x, y, w, h)) return 'Plants should be accents near couches, tables, vending machines, or bookshelves'
  }

  if (isCouchDefId(defId)) {
    const touchesPerimeter = x === 0 || x + w - 1 === world.gridWidth - 1 || y + h - 1 === world.gridHeight - 1
    const inDedicatedSection = hasAdjacentWallPiece(world, x, y, w, h)
    if (!onBackWall && !touchesPerimeter && !inDedicatedSection) {
      return 'Couches should be on the back wall or inside a dedicated lounge section, not in open middle space'
    }
    if (hasCouchFrontBackConflict(world, x, y, w, h)) return 'Do not stack couches front/back — keep lounge circulation clear'
  }

  if (defId === 'bookshelf' && (y < 0 || y + h > BACK_WALL_ROWS)) return 'Bookshelf must fit entirely on the back wall'
  if (defId === 'vending_machine' && (y < 0 || y + h > BACK_WALL_ROWS)) return 'Vending machine must fit entirely on the back wall'
  if ((defId === 'bookshelf' || defId === 'vending_machine') && !hasClearSouthApproach(world, x, y, w, h)) {
    return 'Keep a clear 2-cell path in front of this object — do not block access'
  }
  if (plantOnBackWall && !hasClearSouthApproach(world, x, y, w, h)) {
    return 'Keep a clear 2-cell path in front of the plant — do not block access'
  }
  if (isBlockingDefRequiringClearPath(defId) && (onBackWall || y >= BACK_WALL_ROWS) && !hasClearSouthApproach(world, x, y, w, h)) {
    return 'Keep a clear 2-cell path in front of this object — do not block access'
  }
  if (defId.startsWith('wall_art')) {
    const isMemo = defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b'
    if (!isMemo && y < BACK_WALL_ROWS && world.items.some((item) => item.defId === defId && item.y < BACK_WALL_ROWS)) {
      return 'Use each wall art variant at most once on the back wall'
    }
    if ((defId === 'wall_art_memo_a' || defId === 'wall_art_memo_b') && isWorkstationTopCornerCell(world, x, y)) return ''
    if (isMemo && y < BACK_WALL_ROWS) {
      const backWallMemos = world.items.filter(
        (i) => (i.defId === 'wall_art_memo_a' || i.defId === 'wall_art_memo_b') && i.y < BACK_WALL_ROWS
      ).length
      if (backWallMemos >= 2) return 'Max 2 memos on the back wall'
    }
    for (let dy = 0; dy < h; dy++) {
      if (y + dy === BACK_WALL_ROWS - 1) return 'Wall art cannot be on the bottom row of the back wall'
    }
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (y + dy >= BACK_WALL_ROWS) return 'Wall art must be on the back wall (mid or top row only)'
      }
    }
  }

  if (defId === 'coffee_maker') {
    if (y !== BACK_WALL_ROWS - 1) return 'Coffee maker must be on the bottom row of the back wall (y=2) only'
    if (!hasTableAt(world, x, y)) return 'Coffee maker must be on top of a table — place a table_small on the bottom row of the back wall first, then place the coffee maker on it'
  }

  if (defId === 'post_its') {
    if (!hasWallTopAt(world, x, y) && !hasTableAt(world, x, y) && !isWorkstationTopCornerCell(world, x, y)) return 'Post-its must be placed on top of a wall_top tile, a table (small/large), or the top-left/top-right of a workstation'
  }

  if (isStructuralWallPiece(defId) && isPerimeterDoorEdgeCell(world, x, y) && !wouldHavePerimeterDoorGapAfterWallPlacement(world, x, y)) {
    return 'Keep at least one 2-cell doorway gap on west, east, or south perimeter'
  }
  if (isStructuralWallPiece(defId) && wouldTrapStackedPerimeterChairs(world, x, y)) {
    return 'Do not stack perimeter walls behind multiple chair backs; keep chair access open'
  }
  if (isStructuralWallPiece(defId) && wouldCreateOneCellWallCorridor(world, x, y)) {
    return 'Keep at least a 2-cell buffer between walls; do not create 1-cell corridors'
  }

  return ''
}

export function getComputerFlipped(world: WorldState, x: number, y: number): boolean {
  const desk = getWorkstationAt(world, x, y)
  if (!desk) return false
  // Sprite default faces left; right side (desk.x+3) should face right → flipped: true
  return x >= desk.x + 3
}

export function getChairFlipped(world: WorldState, x: number, y: number): boolean {
  if (isDeskCell(world, x - 1, y)) return true
  if (isDeskCell(world, x + 1, y)) return false
  return false
}

/** Chair color names in workstation atlas (base). Use chair_*_top slice in cell above when left of desk. */
const CHAIR_ATLAS_NAMES = ['chair_red', 'chair_yellow', 'chair_green', 'chair_blue', 'chair_white', 'chair_black'] as const

/** Atlas slice name for this chair (workstation atlas) — base only. For left-of-desk chairs, also draw base + "_top" in the cell above. */
export function getChairAtlasName(world: WorldState, item: PlacedItem): string {
  if (item.defId !== 'chair') return 'chair_blue'
  const chairs = world.items
    .filter((i) => i.defId === 'chair')
    .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x !== b.x ? a.x - b.x : a.id.localeCompare(b.id))
  const index = chairs.findIndex((c) => c.id === item.id)
  return CHAIR_ATLAS_NAMES[index < 0 ? 0 : index % CHAIR_ATLAS_NAMES.length]
}

/** True when this chair is left of the desk (desk to its right). Then draw chair_*_top in the cell above. */
export function isChairLeftOfDesk(world: WorldState, item: PlacedItem): boolean {
  return item.defId === 'chair' && isDeskCell(world, item.x + 1, item.y)
}

/** When placing a chair, return the cell to use. If click is a chair slot (desk.x or desk.x+4 on desk row), use it. Otherwise if click is on a non-slot desk cell, snap to the chair slot beside it. */
export function getChairPlacementCell(world: WorldState, clickX: number, clickY: number): { x: number; y: number } {
  if (isChairSlotPosition(world, clickX, clickY)) return { x: clickX, y: clickY }
  if (!isDeskCell(world, clickX, clickY)) return { x: clickX, y: clickY }
  const rightmostDesk = !isDeskCell(world, clickX + 1, clickY)
  const leftmostDesk = !isDeskCell(world, clickX - 1, clickY)
  if (rightmostDesk && isChairSlotPosition(world, clickX + 1, clickY)) return { x: clickX + 1, y: clickY }
  if (leftmostDesk && isChairSlotPosition(world, clickX - 1, clickY)) return { x: clickX - 1, y: clickY }
  return { x: clickX, y: clickY }
}

/** When placing a computer, return the desk-row base cell. If user clicks the row above the sprite, snap to the desk row. */
export function getComputerPlacementCell(world: WorldState, clickX: number, clickY: number): { x: number; y: number } {
  if (isDeskCellInward(world, clickX, clickY)) return { x: clickX, y: clickY }
  if (isDeskCellInward(world, clickX, clickY + 1)) return { x: clickX, y: clickY + 1 }
  return { x: clickX, y: clickY }
}

/** Stable hash from string to number (for deterministic per-item variant). */
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Atlas slice name for this computer (workstation atlas): computer_a or computer_b at random (stable per item), left/right by desk side. */
export function getComputerAtlasName(world: WorldState, item: PlacedItem): string {
  if (item.defId !== 'computer') return 'computer_a_left'
  const desk = getWorkstationAt(world, item.x, item.y)
  if (!desk) return 'computer_a_left'
  const side = item.x >= desk.x + 3 ? 'right' : 'left'
  const variant = Math.abs(hashString(item.id)) % 2 === 0 ? 'a' : 'b'
  return `computer_${variant}_${side}` as 'computer_a_left' | 'computer_a_right' | 'computer_b_left' | 'computer_b_right'
}

/** Workstations in stable order (by x, then y). */
export function getWorkstationsInOrder(world: WorldState): PlacedItem[] {
  return world.items
    .filter((i) => i.defId === 'workstation')
    .sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y)
}

/** One side of one desk: left = chair left of desk + computer at x+1; right = chair right + computer at x+3. */
export interface DeskSlot {
  workstationIndex: number
  desk: PlacedItem
  side: 'left' | 'right'
  chairX: number
  chairY: number
  computerX: number
  computerY: number
}

/** All desk slots in order (each workstation gives two slots: left, then right). Stable order for assignment. */
export function getDeskSlotsInOrder(world: WorldState): DeskSlot[] {
  const workstations = getWorkstationsInOrder(world)
  const slots: DeskSlot[] = []
  workstations.forEach((desk, wi) => {
    if (desk.defId !== 'workstation') return
    const deskY = desk.y + 1
    slots.push({
      workstationIndex: wi,
      desk,
      side: 'left',
      chairX: desk.x,
      chairY: deskY,
      computerX: desk.x + 1,
      computerY: deskY,
    })
    slots.push({
      workstationIndex: wi,
      desk,
      side: 'right',
      chairX: desk.x + 4,
      chairY: deskY,
      computerX: desk.x + 3,
      computerY: deskY,
    })
  })
  return slots
}

/** Whether this slot has its chair and computer placed. */
export function getSlotCompletion(world: WorldState, slot: DeskSlot): { hasChair: boolean; hasComputer: boolean } {
  const hasChair = world.items.some(
    (i) => i.defId === 'chair' && i.x === slot.chairX && i.y === slot.chairY
  )
  const hasComputer = world.items.some(
    (i) =>
      i.defId === 'computer' && i.x === slot.computerX && i.y === slot.computerY
  )
  return { hasChair, hasComputer }
}

/** Deterministic shuffle for slot assignment (seed from world so same run = same assignment, varies by config). */
export function shuffleSlotsForAssignment<T>(slots: T[], world: WorldState): T[] {
  const seed =
    world.gridWidth * 1000 +
    world.gridHeight * 100 +
    (world.agents?.length ?? 0) * 10 +
    (world.tick ?? 0)
  const out = [...slots]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fff_ffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export function getAgent(world: WorldState, agentId: string): Agent | undefined {
  return world.agents.find((a) => a.id === agentId)
}

export function getArtifactsByType<T extends Artifact['type']>(world: WorldState, type: T): Artifact[] {
  return world.artifacts.filter((a) => a.type === type)
}

/** Cells covered by queued (not yet executed/rejected) proposals. Used to highlight "planned section" tiles in the UI. Unique per cell. */
export function getPlannedCellsFromProposals(world: WorldState): Array<{ x: number; y: number }> {
  const executed = new Set(world.executedProposalIds ?? [])
  const rejected = new Set(world.rejectedProposalIds ?? [])
  const seen = new Set<string>()
  const out: Array<{ x: number; y: number }> = []
  for (const a of world.artifacts ?? []) {
    if (a.type !== 'Proposal' || executed.has(a.id) || rejected.has(a.id)) continue
    const p = a.payload as { defId?: string; x?: number; y?: number; action?: string }
    if (p?.action === 'paint_floor' || p?.action === 'paint_wall') continue
    const defId = normalizeDefId(p?.defId ?? '')
    const px = Number(p?.x)
    const py = Number(p?.y)
    if (defId === '' || Number.isNaN(px) || Number.isNaN(py)) continue
    const def = getItemDef(world, defId)
    if (!def) continue
    const [w, h] = def.footprint
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = px + dx
        const y = py + dy
        if (isInBounds(world, x, y)) {
          const key = `${x},${y}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({ x, y })
          }
        }
      }
    }
  }
  return out
}