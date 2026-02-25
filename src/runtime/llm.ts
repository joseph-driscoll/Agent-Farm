// src/runtime/llm.ts
/**
 * LLM client + prompt builder.
 *
 * CRITICAL CHANGE:
 * - "Good next spots" and placement legality now come from ENGINE getValidPlacementTiles(world, defId).
 * - Removed "shadow sim" canFitAt/buildOccupiedSet drift that caused chair/computer/workstation mismatches.
 */

import {
  PLACEABLE_DEF_IDS_ORDERED,
  ITEM_IMPORTANCE_ORDER,
  WORKSTATION_RULES_TEXT,
  OFFICE_ATLAS_SOURCE,
} from '../config/atlasBuildOrder.js'

import type { MemoryEntry, AgentRole, WorldState, Cell, PlacedItem, ItemDef } from '../engine/schemas.js'
import {
  BACK_WALL_ROWS,
  BUILD_START_ROW,
  AGENT_IN_THE_WAY_REASON,
  getValidPlacementTiles,
  normalizeDefId as normalizeDefIdEngine,
} from '../engine/worldState.js'

import { getDisplayNameForRole } from './agentRoles.js'
import { getSkillCatalogText, formatLoadedSkills } from './skillRegistry.js'
import { log } from '../logger.js'
// Coords: (0,0) top-left, y increases downward (engine coords used in prompts and agent output).
import { parseAgentTurnResponse } from './llmSchema.js'

/** Maximum length for "say" dialogue. */
export const MAX_SAY_LENGTH = 220

export function truncateSay(text: string): string {
  const t = (text ?? '').trim()
  if (t.length <= MAX_SAY_LENGTH) return t
  return t.slice(0, MAX_SAY_LENGTH).trim()
}

export interface AgentTurn {
  say: string
  thought: string
  action: string
  placeItem?: { defId: string; x: number; y: number; flipped?: boolean }
  createArtifact?: { artifactType: string; title?: string; payload: Record<string, unknown> }
  nextProposal?: { defId: string; x: number; y: number; flipped?: boolean }
  vote?: { artifactId: string; vote: 'yes' | 'no' }
  researchQuery?: string | null
  extractUrls?: string[] | null
  crawl?: { url: string; instructions: string } | null
  remember?: { content: string; importance?: number } | null
  loadSkill?: string | null
  createCharacter?: { description: string; n_directions?: number } | null
  animateCharacter?: { characterId: string; animation?: string } | null
  createTileset?: { lower: string; upper: string } | null
  createIsometricTile?: { description: string; size?: number } | null
}

export function formatAgentMemory(memory: MemoryEntry[] | undefined, maxEntries: number = 14): string {
  if (!memory?.length) return ''
  const sorted = [...memory]
    .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5) || b.tick - a.tick)
    .slice(0, maxEntries)
  return sorted.map((m) => `• [t${m.tick}] ${m.content.slice(0, 200)}`).join('\n')
}

function getConfig() {
  return {
    url: process.env.VITE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    openRouterKey: process.env.VITE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY,
    defaultModel: process.env.VITE_LLM_MODEL || process.env.LLM_MODEL || 'openrouter/free',
  }
}

export type SnapshotWorld = {
  tick: number
  gridWidth: number
  gridHeight: number
  agents: Array<{ id: string; name: string; role: string; x: number; y: number; currentIntent?: string }>
  items: Array<{ defId: string; x: number; y: number }>
  itemDefs?: Array<{ id: string; name?: string; footprint: [number, number]; requiresUnlock?: string }>
  artifacts: Array<{ id: string; type: string; title?: string; authorAgentId: string; payload?: Record<string, unknown> }>
  artifactVotes?: Record<string, Record<string, 'yes' | 'no'>>
  executedProposalIds?: string[]
  rejectedProposalIds?: string[]
  cells?: Array<{ x: number; y: number; kind: string; floorPaint?: string; wallPaint?: string; floorFromSlice?: boolean }>
  unlockedTech?: string[]
  chatLog?: Array<{ agentName: string; text: string; kind: string; tick?: number }>
  scores: { power: number; aesthetic: number; collaboration: number; wastePenalty?: number }
  /** When true, no more layout proposals are needed; agents should say the room is finished. */
  layoutSaturated?: boolean
}

export type ConversationPhase = 'intro' | 'planning' | 'building' | 'expanding' | 'finished'

export function getConversationPhase(world: SnapshotWorld, isWarmupPhase: boolean): ConversationPhase {
  if (isWarmupPhase) return 'intro'
  if (world.layoutSaturated === true) return 'finished'
  const workstations = world.items.filter((i) => normalizeDefId(i.defId) === 'workstation').length
  const totalItems = world.items.length
  if (workstations === 0) return 'planning'
  if (totalItems < 6) return 'building'
  return 'expanding'
}

/** Normalize defId consistently with engine rules. */
function normalizeDefId(defId: string): string {
  return normalizeDefIdEngine(defId)
}

/** Inflate SnapshotWorld into a WorldState-like object so we can reuse engine placement rules. */
function snapshotToWorldState(world: SnapshotWorld): WorldState {
  const w = world.gridWidth
  const h = world.gridHeight

  const defaultCells: Cell[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const kind = y < BACK_WALL_ROWS ? 'wall' : 'floor'
      defaultCells.push({ x, y, kind, roomId: 'main' })
    }
  }

  const cells: Cell[] =
    world.cells && world.cells.length > 0
      ? world.cells.map((c) => ({
          x: c.x,
          y: c.y,
          kind: (c.kind as any) ?? (c.y < BACK_WALL_ROWS ? 'wall' : 'floor'),
          roomId: 'main',
          floorPaint: c.floorPaint,
          wallPaint: c.wallPaint,
          floorFromSlice: c.floorFromSlice,
        }))
      : defaultCells

  const itemDefs: ItemDef[] =
    (world.itemDefs as any) ??
    [] // If missing, getValidPlacementTiles will return empty; but in your app itemDefs are included.

  const items: PlacedItem[] = world.items.map((i, idx) => ({
    id: `snap-item-${world.tick}-${idx}`,
    defId: normalizeDefId(i.defId),
    x: i.x,
    y: i.y,
    placedAtTick: Math.max(0, world.tick - 1),
    flipped: false,
  }))

  return {
    tick: world.tick,
    gridWidth: w,
    gridHeight: h,
    cells,
    items,
    itemDefs,
    agents: [], // placement rules look at agents for blocking; snapshot prompt shouldn't depend on agent blocking.
    artifacts: [],
    unlockedTech: world.unlockedTech ?? [],
    scores: {
      power: world.scores.power,
      aesthetic: world.scores.aesthetic,
      collaboration: world.scores.collaboration,
      wastePenalty: world.scores.wastePenalty ?? 0,
    },
    lastEvents: [],
    chatLog: [],
    artifactVotes: world.artifactVotes ?? {},
    executedProposalIds: world.executedProposalIds ?? [],
    rejectedProposalIds: world.rejectedProposalIds ?? [],
    mode: undefined,
    modeNote: undefined,
  }
}

/** Compute occupied cells authoritatively from itemDefs footprints (same as engine placement occupancy). */
function buildOccupiedCellsAuthoritative(world: SnapshotWorld): string {
  const defById = new Map<string, { footprint: [number, number] }>()
  for (const d of world.itemDefs ?? []) defById.set(d.id, { footprint: d.footprint })

  const cells = new Map<string, string>()
  for (const item of world.items) {
    const defId = normalizeDefId(item.defId)
    const fp = defById.get(defId)?.footprint ?? ([1, 1] as [number, number])
    const [fw, fh] = fp
    for (let dy = 0; dy < fh; dy++) {
      for (let dx = 0; dx < fw; dx++) {
        const cx = item.x + dx
        const cy = item.y + dy
        cells.set(`${cx},${cy}`, defId)
      }
    }
  }

  const entries = [...cells.entries()].sort((a, b) => {
    const [xa, ya] = a[0].split(',').map(Number)
    const [xb, yb] = b[0].split(',').map(Number)
    return ya - yb || xa - xb
  })

  if (entries.length === 0) return 'none'
  return entries
    .map(([key, defId]) => {
      const [x, y] = key.split(',').map(Number)
      return `(${x},${y})=${defId}`
    })
    .join(', ')
}

/** One-line reality summary for logging and prompt. */
export function getRealitySummary(world: SnapshotWorld): {
  deskStatus: string
  workstations: number
  chairs: number
  computers: number
  realityLine: string
} {
  const workstations = world.items.filter((i) => normalizeDefId(i.defId) === 'workstation').length
  const chairs = world.items.filter((i) => normalizeDefId(i.defId) === 'chair').length
  const computers = world.items.filter((i) => normalizeDefId(i.defId) === 'computer').length
  const deskStatus = buildDeskStatus(world)
  const realityLine =
    workstations === 0
      ? `REALITY: ZERO workstations. ZERO desks, ZERO chairs, ZERO computers. Room is empty. Do NOT say workstations, desks, chairs, or computers exist.`
      : `REALITY: ${workstations} workstation(s); ${chairs} chair(s); ${computers} computer(s). PER-DESK: ${deskStatus}`
  return { deskStatus, workstations, chairs, computers, realityLine }
}

/** Desk status helper (kept from your logic, but using normalized defIds). */
export function buildDeskStatus(world: SnapshotWorld): string {
  const workstations = world.items.filter((i) => normalizeDefId(i.defId) === 'workstation')
  if (workstations.length === 0) return 'No workstations yet.'
  const has = (defId: string, x: number, y: number) =>
    world.items.some((it) => normalizeDefId(it.defId) === defId && it.x === x && it.y === y)

  const lines = workstations.map((ws) => {
    const deskRowY = ws.y + 1
    const leftChair = has('chair', ws.x, deskRowY)
    const rightChair = has('chair', ws.x + 4, deskRowY)
    const leftComputer = has('computer', ws.x + 1, deskRowY)
    const rightComputer = has('computer', ws.x + 3, deskRowY)
    const left = `left: chair ${leftChair ? 'placed' : 'MISSING'}, computer ${leftComputer ? 'placed' : 'MISSING'}`
    const right = `right: chair ${rightChair ? 'placed' : 'MISSING'}, computer ${rightComputer ? 'placed' : 'MISSING'}`
    return `Desk at (${ws.x},${ws.y}): ${left}; ${right}.`
  })
  return lines.join(' ')
}

function buildChronologicalConversationThread(chatLog: SnapshotWorld['chatLog'], maxEntries: number = 28): string {
  const entries = (chatLog ?? []).filter((e) => e.kind === 'say').slice(-maxEntries)
  return entries
    .map((e) => {
      const tickLabel = e.tick != null ? `[Tick ${e.tick}] ` : ''
      return `${tickLabel}${e.agentName}: ${e.text.slice(0, 180)}`
    })
    .join('\n')
}

function buildWhatExistsNow(world: SnapshotWorld): string {
  const itemsList = world.items.length
    ? world.items.map((i) => `${normalizeDefId(i.defId)} @ ${i.x},${i.y}`).join('; ')
    : 'none'
  return `Placed items (type and location): ${itemsList}.`
}

/** Deterministic shuffle so lists vary but remain replay-stable. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fff_ffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function buildReferenceImageGuidance(): string {
  return [
    'REFERENCE IMAGE (PixelOffice.png): Use this to describe the true look and colors of assets.',
    'WORKSTATION RULES (mandatory): ' + WORKSTATION_RULES_TEXT,
  ].join(' ')
}

/**
 * Build "Good next spots" using ENGINE getValidPlacementTiles.
 * This is the single biggest stabilization move in your whole system.
 */
function buildGoodNextSpots(world: SnapshotWorld): string {
  const engineWorld = snapshotToWorldState(world)

  const unlocked = new Set(engineWorld.unlockedTech ?? [])
  const placeableDefs = (engineWorld.itemDefs ?? []).filter((d) => !d.requiresUnlock || unlocked.has(d.requiresUnlock))
  const allowed = new Set(placeableDefs.map((d) => d.id))
  const allowedInOrder = PLACEABLE_DEF_IDS_ORDERED.filter((id) => {
    if (!allowed.has(id)) return false
    // Structural wall pieces (wall_top, corner/edge pieces) and wall art are allowed in good next spots.
    return true
  })

  // Seed based on world state so the "top 6" vary but stay deterministic per tick+layout.
  const seed = world.tick * 1000 + world.items.reduce((s, i) => s + i.x * 7 + i.y * 31 + normalizeDefId(i.defId).length, 0)
  let order = seededShuffle(allowedInOrder, seed)

  // Keep wall pieces visible early, but do not force wall-heavy runs for too long.
  const workstations = world.items.filter((i) => normalizeDefId(i.defId) === 'workstation').length
  const wallPieceDefIds = ['wall_top', 'wall_top_left', 'wall_top_right', 'wall_left', 'wall_right', 'wall_bottom', 'wall_bottom_left', 'wall_bottom_right']
  const wallPieceCount = world.items.filter((i) => wallPieceDefIds.includes(normalizeDefId(i.defId))).length
  if (workstations > 0 && wallPieceCount < 6 && order.includes('wall_top')) {
    order = ['wall_top', ...order.filter((id) => id !== 'wall_top')]
  }

  const backWallRowY = BACK_WALL_ROWS - 1
  const parts: string[] = []
  for (const defId of order) {
    let tiles = getValidPlacementTiles(engineWorld, defId)
    if (!tiles.length) continue
    // Keep wall piece progression stable: back wall row first (e.g. (0,2), (1,2)); corners can appear at (0,2), (width-1,2), etc.
    if (wallPieceDefIds.includes(defId)) {
      tiles = [
        ...tiles.filter((t) => t.y === backWallRowY).sort((a, b) => a.x - b.x),
        ...tiles.filter((t) => t.y !== backWallRowY).sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)),
      ]
    }
    const maxShow = wallPieceDefIds.includes(defId) ? 12 : 6
    const show = tiles.slice(0, maxShow).map((t) => `(${t.x},${t.y})`).join(', ')
    parts.push(`${defId}: ${show}`)
  }

  return parts.length ? parts.join(' | ') : 'none'
}

function buildWallProgress(world: SnapshotWorld): string {
  const gw = world.gridWidth
  const gh = world.gridHeight
  const floorEndY = gh - 1
  const perimeterMinY = BUILD_START_ROW
  const maxDoorwayGap = 2

  const wallPieceDefIds = ['wall_top', 'wall_top_left', 'wall_top_right', 'wall_left', 'wall_right', 'wall_bottom', 'wall_bottom_left', 'wall_bottom_right']
  const wallCells = new Set<string>()
  for (const item of world.items) {
    if (!wallPieceDefIds.includes(normalizeDefId(item.defId))) continue
    wallCells.add(`${item.x},${item.y}`)
  }

  const countBottom = (() => {
    let n = 0
    for (let x = 0; x < gw; x++) if (wallCells.has(`${x},${floorEndY}`)) n++
    return n
  })()

  const countLeft = (() => {
    let n = 0
    for (let y = perimeterMinY; y <= floorEndY; y++) if (wallCells.has(`0,${y}`)) n++
    return n
  })()

  const countRight = (() => {
    let n = 0
    for (let y = perimeterMinY; y <= floorEndY; y++) if (wallCells.has(`${gw - 1},${y}`)) n++
    return n
  })()

  const bottomLen = gw
  const sideLen = floorEndY - perimeterMinY + 1
  const bottomFramed = countBottom >= Math.max(1, bottomLen - maxDoorwayGap)
  const leftFramed = countLeft >= Math.max(1, sideLen - maxDoorwayGap)
  const rightFramed = countRight >= Math.max(1, sideLen - maxDoorwayGap)
  const perimeterHasAny = countBottom > 0 || countLeft > 0 || countRight > 0

  return [
    `Perimeter wall counts (any wall piece): left=${countLeft}/${sideLen}, bottom=${countBottom}/${bottomLen}, right=${countRight}/${sideLen}.`,
    `Bottom framed (allows up to 2-cell doorway): ${bottomFramed ? 'YES' : 'NO'}.`,
    `Left framed (allows up to 2-cell doorway): ${leftFramed ? 'YES' : 'NO'}.`,
    `Right framed (allows up to 2-cell doorway): ${rightFramed ? 'YES' : 'NO'}.`,
    `Any perimeter wall exists: ${perimeterHasAny ? 'YES' : 'NO'}.`,
    'Never say bottom/perimeter is framed, complete, done, or finished unless the relevant line above is YES.',
  ].join(' ')
}

/** Location phrases for "say": accurate to grid so agents describe placement in words, not coords. */
function buildLocationVocabulary(
  gw: number,
  gh: number,
  backWallEndY: number,
  _floorStartY: number,
  floorEndY: number
): string {
  const midX = (gw - 1) / 2
  const lines: string[] = [
    `When you speak about where something is or will be placed, use these phrases (never raw coordinates like (0,2)). Grid is ${gw}×${gh}.`,
    `• Back wall = top of grid (y=0 to y=${backWallEndY}). Use for wall_top or wall_art.`,
    `• Top-left / top-right = corners at the top (y near 0, x=0 or x=${gw - 1}).`,
    `• Bottom-left / bottom-right = corners at the bottom (y=${floorEndY}, x=0 or x=${gw - 1}).`,
    '• Perimeter = west (x=0), south/bottom (y=' + floorEndY + '), or east (x=' + (gw - 1) + ') edges only — not the back wall. Do NOT say "perimeter wall complete" or "perimeter complete" when only the back wall has wall_top tiles. Perimeter requires left, bottom, or right border to have wall_top (with or without a doorway).',
    `• Center = middle of the room (x near ${Math.round(midX)}). Center-left = left of center; center-right = right of center.`,
    '• Left side = small x; right side = large x.',
    `• Front of the room = toward the bottom (high y, near y=${floorEndY}). "Closer to the front" = toward the bottom.`,
    '• Back of the room / toward the back = toward the top (low y, near the back wall). "Closer to the back" = toward y=0.',
    '• Interior = inside the floor area, not on perimeter. E.g. "interior divider", "center of the room".',
  ]
  return lines.join(' ')
}

function buildGridAwareness(world: SnapshotWorld): string {
  const gw = world.gridWidth
  const gh = world.gridHeight
  const backWallEndY = BACK_WALL_ROWS - 1
  const floorStartY = BUILD_START_ROW
  const floorEndY = gh - 1
  const lines: string[] = []

  lines.push(
    `Grid: (0,0) top-left, y increases downward. Back wall (top): rows y=0 to y=${backWallEndY}.`
  )
  lines.push(
    `Corners: top-left=(0,0), top-right=(${gw - 1},0), bottom-left=(0,${floorEndY}), bottom-right=(${gw - 1},${floorEndY}).`
  )
  lines.push(
    `Coordinate truth: (0,0) is top-left. Y increases downward.`
  )
  lines.push(
    `Back wall rows (not floor): y=0..${backWallEndY}. Floor rows: y=${floorStartY}..${floorEndY}.`
  )
  lines.push(
    `Floor build starts at y=${floorStartY} (workstations/chairs/computers cannot be in buffer rows). Workstations: even spacing always — same aisle width between all columns (all 2-cell or all 3-cell, never mixed), equal space on left and right sides, stacks aligned in columns.`
  )
  lines.push(
    `Perimeter guide: west border x=0, east border x=${gw - 1}, south border (bottom) y=${floorEndY}.`
  )
  lines.push(
    `Chair cells are WALKABLE (agents can stand/sit on chairs). Workstations and most furniture block movement via nav grid.`
  )

  lines.push('--- LOCATION VOCABULARY (use these in "say" instead of coordinates) ---')
  lines.push(buildLocationVocabulary(gw, gh, backWallEndY, floorStartY, floorEndY))

  lines.push('--- OCCUPIED CELLS (authoritative) ---')
  lines.push(buildOccupiedCellsAuthoritative(world))

  lines.push('--- GOOD NEXT SPOTS (ENGINE-VALIDATED) ---')
  lines.push(buildGoodNextSpots(world))

  return lines.join('\n')
}

function buildSatisfaction(world: SnapshotWorld): string {
  const counts: Record<string, number> = {}
  for (const item of world.items) {
    const id = normalizeDefId(item.defId)
    counts[id] = (counts[id] ?? 0) + 1
  }
  const lines: string[] = []
  lines.push('Already placed: ' + (Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') : 'nothing yet'))

  if (world.layoutSaturated === true) {
    lines.push('Layout is complete — no more additions needed. In "say" acknowledge that the room is finished (e.g. "The room is done", "We\'re finished with the layout", "Looks good — we\'re done here"). Do NOT repeat "Time to expand the back wall" or suggest more building.')
    return lines.join('\n')
  }

  const workstations = counts['workstation'] ?? 0
  const chairs = counts['chair'] ?? 0
  const computers = counts['computer'] ?? 0
  const wallTop = counts['wall_top'] ?? 0
  const wallArt = Object.entries(counts)
    .filter(([id]) => id.startsWith('wall_art'))
    .reduce((sum, [, n]) => sum + n, 0)
  const agentCount = world.agents?.length ?? 3

  const needMoreChairsOrComputers = workstations > 0 && (chairs < agentCount || computers < agentCount)
  if (needMoreChairsOrComputers) {
    lines.push('Desks exist — prioritize chairs/computers, while still mixing in occasional walls/decor (no long wall-only streak).')
  } else if (workstations > 0 && wallTop < 18) {
    lines.push('Mix wall_top with decor/furniture in short bursts. Build back strip and sections gradually; do not spam walls before objects.')
  } else if (workstations > 0) {
    lines.push('Desks are started — continue with balanced additions: walls, decor, and furniture interleaved for a smooth layout flow.')
  } else {
    lines.push('Room is empty — start organically: first workstation plus some back-strip/decor is fine; avoid rigid phase locks.')
  }
  if (wallArt > 0 && wallTop < 18) {
    lines.push('Wall art is present but wall_top is still sparse — propose wall_top from Good next spots to add more wall surface.')
  }
  return lines.join('\n')
}

/** Proposals not yet built and not rejected. */
function getUnexecutedProposals(world: SnapshotWorld): Array<{ id: string; payload?: Record<string, unknown> }> {
  const executed = world.executedProposalIds ?? []
  const rejected = world.rejectedProposalIds ?? []
  return world.artifacts.filter((a) => a.type === 'Proposal' && !executed.includes(a.id) && !rejected.includes(a.id))
}

function buildApprovedProposalsToPlace(world: SnapshotWorld): string[] {
  const unexecuted = getUnexecutedProposals(world)
  const lines: string[] = []
  if (unexecuted.length === 0) {
    lines.push('(queue empty — Architect can add createArtifact Proposal; max 2 in queue)')
    return lines
  }
  lines.push('Next to do (Builder — do this one):')
  for (let i = 0; i < unexecuted.length; i++) {
    const a = unexecuted[i]!
    const p = a.payload as { defId?: string; x?: number | string; y?: number | string }
    if (p?.defId == null || p.x == null || p.y == null) continue
    const x = Number(p.x)
    const y = Number(p.y)
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    const label = i === 0 ? '→' : 'Then:'
    lines.push(`- ${label} place ${normalizeDefId(p.defId)} at ${x},${y}`)
  }
  return lines
}

const WORLD_RULES_DIALOGUE = [
  '*** WORLD RULES (dialogue — mandatory) ***',
  '• Use "What exists right now", "PER-DESK STATUS", and "OCCUPIED CELLS" as truth.',
  '• Use "WALL PROGRESS (authoritative)" as truth for any claim about perimeter/bottom/left/right being framed or complete.',
  '• Do not claim chairs/computers are done unless PER-DESK says placed.',
  '• The phrase "back wall" refers ONLY to wall_top painting/sections. Never describe workstations/chairs/computers as being on or completing the back wall.',
  '• Back wall rows 0 and 1: only wall_art, vending_machine, and bookshelf. Couches, water cooler, tables, plants, etc. can only be on row 2 on the back wall (and can be built over wall on row 2). On the floor any valid row. Workstations/chairs/computers are floor-only.',
  '• Do not block entrances: keep perimeter doorways (2–3 cell gaps) clear; objects must keep a clear 2-cell path in front (like tables).',
  '• Perimeter = left (x=0), bottom (y=bottom row), or right (x=right) edges only. Do NOT say "perimeter wall complete" or "perimeter complete" when only the back wall has tiles — back wall is separate; perimeter means at least one of left/bottom/right borders has wall_top (with or without doorway).',
  '• Building the room perimeter (west, east, south) with wall_top is valid for both agents and humans; same rules apply. Keep at least one 2-cell doorway on west, east, or south; then perimeter walls are allowed. This is a normal, supported layout.',
  '• If WALL PROGRESS says Bottom framed: NO, do not claim bottom perimeter is framed/complete/done/finished.',
  '• If WALL PROGRESS says Any perimeter wall exists: NO, do not claim perimeter progress at all.',
  '• Do not place/claim stacked perimeter walls directly behind chair backs. A single nearby perimeter wall by one workstation is okay; stacked runs that wall in chairs are not.',
  '• Keep at least a 2-cell buffer between perimeter walls and interior sections, and between parallel sections. Avoid 1-cell wall corridors.',
  '• Wall art: you have calendar, flags, sunset, sun, memos, etc. Variation is good; repetitive overuse of one type is waste. Caps: max 5 post-its, max 4 memos total, max 2 memos on back wall. Post-its on tables, workstation tops, section walls. Only 2 watercoolers, 3 bookshelves, 2 vending machines max or it is waste.',
  '• Chairs are walkable; do not claim they block movement.',
  '• Build flow should be organic: mix walls/sections with desks/decor in short bursts instead of long wall-only streaks.',
  '• In "say", describe locations using the LOCATION VOCABULARY (e.g. "on the back wall", "center-left", "perimeter near the door", "closer to the front of the room") — never raw coordinates like (0,2). Use Good next spots only for the actual (x,y) in JSON.',
].join('\n')

const WALL_TOP_SECTION_POLICY = [
  '*** WALL / SECTION POLICY ***',
  '• Use wall pieces for walls/dividers: wall_top, wall_top_left, wall_top_right, wall_left, wall_right, wall_bottom, wall_bottom_left, wall_bottom_right. Same placement rules for all (perimeter door gap, chair trap, 1-cell corridor). Propose using (defId, x, y) from Good next spots.',
  '• Corner pieces go in corners: e.g. perimeter top-left (0,2), top-right (width-1,2); section corners. Use wall_top_left / wall_top_right at horizontal corners; wall_bottom_left / wall_bottom_right at bottom corners; wall_left / wall_right on vertical runs.',
  '• Back wall, perimeter (west/east/south with one 2-cell doorway), and interior dividers are all valid. Same rules for agents and humans: perimeter with doorway is allowed and encouraged when it fits the layout.',
  '• Room shapes and sizes are up to you; vary the layout from run to run.',
].join('\n')

function stripCoordinatesFromSay(text: string): string {
  if (!text) return text
  return text
    .replace(/\s*\(\s*\d+\s*,\s*\d+\s*\)/g, ' there')
    .replace(/\s+at\s+\(\s*\d+\s*,\s*\d+\s*\)/gi, ' in a good spot')
    .replace(/\s+like\s+\(\s*\d+\s*,\s*\d+\s*\)/gi, ' in a good spot')
    .replace(/\s+\(\s*\d+\s*,\s*\d+\s*\)\s+/g, ' there ')
    .trim()
}

function sanitizePlacementDialogue(text: string): string {
  if (!text) return text
  return text
    .replace(/\bworkstation(s?)\s+against\s+the\s+back\s+wall\b/gi, 'workstation$1 on the floor')
    .replace(/\bworkstation\s+area\s+against\s+the\s+back\s+wall\b/gi, 'workstation area on the floor')
    .replace(/\bback\s+wall\s+complete\b/gi, 'Back wall wall_top complete')
    .replace(/\bback\s+wall\s+done\b/gi, 'Back wall wall_top done')
    .replace(
      /\b(back\s+wall(?:\s+wall_top)?\s+(?:complete|done)[^.]*)\bworkstations?\b/gi,
      (m) => m.replace(/back\s+wall(?:\s+wall_top)?/i, 'desk/floor layout')
    )
}

function sanitizeSayForRules(text: string): string {
  return sanitizePlacementDialogue(stripCoordinatesFromSay(text))
}

const BANNED_PHRASES = /\b(finalize|wrap\s*(it\s*)?up|let'?s\s*(align|finalize)|ready\s*when\s*you\s*are)\b/i
const BANNED_LOOP_PHRASES: RegExp[] = [
  /checking\s+in\s*[—\-]\s*how'?s\s+the\s+build\s+going\s*\??/i,
  /checking\s+in\s*\.?\s*$/i,
  /^on\s+it\.?\s*$/i,
]

export function filterBannedPhrases(text: string): string {
  if (!text) return text
  if (BANNED_PHRASES.test(text)) return ''
  if (BANNED_LOOP_PHRASES.some((re) => re.test(text))) return ''
  return sanitizeSayForRules(text)
}

export function buildWorldSnapshot(
  world: SnapshotWorld,
  _researchSnippet?: string,
  isWarmupPhase?: boolean,
  lastPlacementFailure?: string
): string {
  const conversationPhase = getConversationPhase(world, isWarmupPhase === true)
  const recentChat = buildChronologicalConversationThread(world.chatLog)

  const agentsStr = world.agents
    .map((a) => `${a.name} (${getDisplayNameForRole(a.role as AgentRole)}) @ ${Math.floor(a.x)},${Math.floor(a.y)}${a.currentIntent ? ` intent=${a.currentIntent}` : ''}`)
    .join('\n')

  const { realityLine } = getRealitySummary(world)
  const failureBlock = lastPlacementFailure
    ? lastPlacementFailure === AGENT_IN_THE_WAY_REASON
      ? `\n*** LAST PLACEMENT FAILED: ${lastPlacementFailure} — retry until clear. ***\n`
      : `\n*** LAST PLACEMENT FAILED: ${lastPlacementFailure} — proposal skipped; move on. ***\n`
    : ''

  const whatExistsNow = buildWhatExistsNow(world)
  const deskStatus = buildDeskStatus(world)
  const occupiedCells = buildOccupiedCellsAuthoritative(world)
  const wallProgress = buildWallProgress(world)

  const placementOrder = [
    'Unlocked: ' + ((world.unlockedTech ?? []).length ? (world.unlockedTech ?? []).join(', ') : 'none'),
    `Placeable defIds (from ${OFFICE_ATLAS_SOURCE}):`,
    PLACEABLE_DEF_IDS_ORDERED.join(', '),
    'Example order (you may choose differently): ' + ITEM_IMPORTANCE_ORDER.slice(0, 12).join(', '),
    'Suggested flow: workstations and seating, then walls/dividers and decor — or decide as a team and vary the layout each run.',
  ].join('\n')

  const gridAwareness = buildGridAwareness(world)
  const satisfaction = buildSatisfaction(world)
  const referenceImageGuidance = buildReferenceImageGuidance()

  return [
    realityLine,
    '',
    `Tick: ${world.tick} | Grid: ${world.gridWidth}x${world.gridHeight} | Scores: P=${world.scores.power.toFixed(0)} A=${world.scores.aesthetic.toFixed(0)} C=${world.scores.collaboration.toFixed(0)}`,
    'Agents:',
    agentsStr,
    '--- WHAT EXISTS RIGHT NOW ---',
    whatExistsNow,
    '--- PER-DESK STATUS ---',
    deskStatus,
    '--- WALL PROGRESS (authoritative) ---',
    wallProgress,
    '--- OCCUPIED CELLS ---',
    occupiedCells,
    failureBlock,
    '--- REFERENCE IMAGE ---',
    referenceImageGuidance,
    WORLD_RULES_DIALOGUE,
    WALL_TOP_SECTION_POLICY,
    '--- GRID AWARENESS ---',
    gridAwareness,
    '--- SATISFACTION ---',
    satisfaction,
    '--- UNLOCK & PLACEMENT ---',
    placementOrder,
    '--- PIPELINE ---',
    'Build queue:',
    ...buildApprovedProposalsToPlace(world),
    '--- CONVERSATION ---',
    `Phase: ${conversationPhase}.`,
    conversationPhase === 'finished'
      ? 'In your reply "say", acknowledge that the room is finished (e.g. "The room is done", "We\'re done adding stuff", "Layout looks good — we\'re finished"). Do NOT say "Time to expand the back wall" or suggest more building.'
      : 'In your reply "say", only discuss the current phase. Do not suggest or propose specific builds (e.g. do not say "Let\'s add a small interior divider" or "Let\'s add X"); proposing is the Manager\'s job. Discuss what exists or what the current phase is about.',
    'Thread (oldest to newest):',
    recentChat || '(no messages yet)',
  ].join('\n')
}

/* ------------------------- PROMPT BUILD (unchanged-ish) ------------------------- */

export function buildPrompt(
  agentName: string,
  role: string,
  worldSnapshot: string,
  pipelineContext: any,
  agentRecentLines?: string[]
): string {
  const skillCatalogBlock = getSkillCatalogText()
  const loadedSkillsBlock = formatLoadedSkills(pipelineContext?.loadedSkills ?? [])
  const memoryBlock =
    pipelineContext?.agentMemoryText && String(pipelineContext.agentMemoryText).trim()
      ? `\n--- YOUR MEMORY ---\n${pipelineContext.agentMemoryText}\n---\n`
      : ''

  const recentBlock =
    agentRecentLines && agentRecentLines.length > 0
      ? `\nYour last messages — do NOT repeat:\n${agentRecentLines.map((l) => `- ${l}`).join('\n')}\n`
      : ''

  return `You are ${agentName}, the ${getDisplayNameForRole(role as AgentRole)}.
${skillCatalogBlock}
${loadedSkillsBlock}
${memoryBlock}
${recentBlock}

Current world:
${worldSnapshot}

Reply with JSON only. Keep "say" under ${MAX_SAY_LENGTH} chars. In "say", only discuss the current phase (see CONVERSATION Phase above); do not suggest or propose specific builds (e.g. do not say "Let\'s add X"). When placing or proposing, use location words (back wall, center-left, perimeter, front of room, etc.) — never raw coordinates.
All coordinates in JSON (placeItem / nextProposal / createArtifact payload) must use (0,0) top-left, y increases downward.
{
  "say": "",
  "thought": "",
  "action": "hold | sit_in_chair | research | propose | place_item | expand_room",
  "placeItem": null,
  "createArtifact": null,
  "vote": null,
  "remember": null,
  "loadSkill": null,
  "researchQuery": null,
  "extractUrls": null,
  "crawl": null
}`
}

/* ---------------------------- OPENAI / OR ROUTER ---------------------------- */

export async function getAgentTurn(
  agentName: string,
  role: string,
  worldSnapshot: string,
  pipelineContext: any,
  agentRecentLines?: string[]
): Promise<AgentTurn> {
  const { url: baseUrl, openaiKey, openRouterKey, defaultModel } = getConfig()
  const model = pipelineContext?.model ?? defaultModel
  const isOpenRouterModel = String(model).includes('/')
  const apiKey = isOpenRouterModel ? openRouterKey : openaiKey

  if (!apiKey) {
    const keyName = isOpenRouterModel ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
    log('LLM', 'no API key', { agent: agentName, keyName })
    return { say: '', thought: `No API key (${keyName}).`, action: 'hold' }
  }

  const prompt = buildPrompt(agentName, role, worldSnapshot, pipelineContext, agentRecentLines)
  const apiBaseUrl = isOpenRouterModel ? 'https://openrouter.ai/api/v1' : String(baseUrl).replace(/\/$/, '')
  const url = `${apiBaseUrl}/chat/completions`

  const body = {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: 512,
    temperature: 0.8,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  if (isOpenRouterModel || apiBaseUrl.includes('openrouter.ai')) {
    headers['Referer'] = 'https://github.com/agent-farm'
    headers['X-Title'] = 'Agent Farm'
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70000),
    })

    const raw = await res.text()
    if (!res.ok) {
      const msg = raw.slice(0, 240)
      log('LLM', 'API error', { agent: agentName, status: res.status, msg })
      const retryable = res.status === 402 || res.status === 400 || res.status === 429 || (res.status >= 500 && res.status < 600)
      if (retryable) {
        const err = new Error(`API ${res.status}: ${msg}`) as Error & { status?: number; providerMessage?: string }
        err.status = res.status
        err.providerMessage = msg
        throw err
      }
      return { say: `⚠️ API error (${res.status})`, thought: msg, action: 'hold' }
    }

    const data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content?.trim() ?? ''
    const turn = parseAgentTurnResponse(content)
    turn.say = filterBannedPhrases(turn.say ?? '')
    turn.thought = ''
    return turn
  } catch (e) {
    const err = e as Error & { status?: number }
    const msg = err.message
    log('LLM', 'request failed', { agent: agentName, error: msg })
    const status = err.status
    const retryable =
      status === 402 ||
      status === 400 ||
      status === 429 ||
      (typeof status === 'number' && status >= 500 && status < 600)
    if (retryable) throw err
    return { say: '', thought: `Error: ${msg}`, action: 'hold' }
  }
}

// Structured response parsing moved to llmSchema.ts
