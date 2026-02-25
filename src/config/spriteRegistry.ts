/**
 * Sprites: all from workstation_atlas.json; image is office-assets.png.
 * Positions are read from the JSON — when you move sprites on the sheet, re-export
 * the atlas so workstation_atlas.json stays in sync with office-assets.png.
 * Office atlas is only used for frames not in workstation atlas (e.g. floor).
 */

import type { SpriteRegion } from './workstationPieces'
import { ROLE_TO_AGENT_FRAME } from './officeAtlas'

import workstationAtlasData from './workstation_atlas.json'
import officeAtlasData from './office_atlas.json'

interface OfficeAtlasFrame {
  frame: { x: number; y: number; w: number; h: number }
}
interface OfficeAtlas {
  frames: Record<string, OfficeAtlasFrame>
  renderLayers?: Record<string, number>
}

interface WorkstationAtlasSlice {
  name: string
  keys: Array<{ frame: number; bounds: { x: number; y: number; w: number; h: number } }>
}
interface WorkstationAtlas {
  meta?: { slices?: WorkstationAtlasSlice[] }
}

const officeAtlas = officeAtlasData as OfficeAtlas
const workstationAtlas = workstationAtlasData as WorkstationAtlas

export const CELL_PX = 16
/** Row height in px (16). Workstation is 5×2 cells = 80×32. */
export const CELL_PX_Y = 16

export const SPRITE_SHEET_URL = '/office-assets.png'

export type { SpriteRegion }

export interface SpriteEntry {
  sheetUrl: string
  region: SpriteRegion
  renderLayer?: number
}

const registry = new Map<string, SpriteEntry>()

// Workstation atlas: all slices (chairs, computers, tables, plants, water_cooler, coffee_maker, wall_art, workstation)
const slices = workstationAtlas.meta?.slices ?? []
for (const slice of slices) {
  const bounds = slice.keys?.[0]?.bounds
  if (!bounds) continue
  registry.set(slice.name, {
    sheetUrl: SPRITE_SHEET_URL,
    region: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
  })
}
// Default aliases for defIds that use a specific variant
if (!registry.has('computer_a') && registry.has('computer_a_left')) {
  registry.set('computer_a', registry.get('computer_a_left')!)
}

// Office atlas: only frames not in workstation atlas (bookshelf, vending_machine, trashcan, couch, agents, etc.)
const renderLayers = officeAtlas.renderLayers ?? {}
for (const [name, data] of Object.entries(officeAtlas.frames)) {
  if (registry.has(name)) continue
  const f = data.frame
  registry.set(name, {
    sheetUrl: SPRITE_SHEET_URL,
    region: { x: f.x, y: f.y, w: f.w, h: f.h },
    renderLayer: renderLayers[name],
  })
}

/** defId → primary atlas slice name (workstation_atlas preferred). */
const DEF_ID_TO_ATLAS_FRAME: Record<string, string> = {
  chair: 'chair_blue',
  plant: 'small_plant_smooth',       // also use small_plant_smooth_top for 1×2 plant
  plant_bushy: 'small_plant_bushy',  // also use small_plant_bushy_top for 1×2
  plant_large: 'large_plant_smooth', // 1×2 with large_plant_bushy as top
  computer: 'computer_a',
  trashcan: 'trashcan_green_bottom',
  trashcan_red: 'trashcan_red_bottom',
  recycling_bin: 'recycling_bin',
  couch: 'couch_blue',
  wall_art: 'wall_art_calendar', // 2×1 calendar from workstation_atlas (not office atlas)
  wall_art_sun: 'wall_art_sun',
  wall_art_sunset: 'wall_art_sunset',
  wall_art_sun_rise: 'wall_art_sun_rise',
  wall_art_usa_flag: 'wall_art_usa_flag',
  wall_art_england_flag: 'wall_art_england_flag',
  wall_art_india_flag: 'wall_art_india_flag',
  wall_art_memo_a: 'wall_art_memo_a',
  wall_art_memo_b: 'wall_art_memo_b',
  watercooler: 'water_cooler_base',   // also use water_cooler_top
  coffee_maker: 'coffee_maker',
  table_large: 'table_large',
  table_small: 'table_small',
  floor: 'floor_a',   // floor tile from office atlas
}

export function getSprite(defId: string): SpriteEntry | undefined {
  const frameName = DEF_ID_TO_ATLAS_FRAME[defId] ?? defId
  return registry.get(frameName)
}

/** DefIds that have a top layer (top slice or chair back). These render in front of agents so agents walk behind them. */
export const TOP_LAYER_DEF_IDS = [
  'chair',
  'plant',
  'plant_bushy',
  'plant_large',
  'watercooler',
] as const

/** For items that render as two stacked slices (top + base), returns the top slice name or undefined. */
export function getTwoPartTopSliceName(defId: string): string | undefined {
  const base = DEF_ID_TO_ATLAS_FRAME[defId] ?? defId
  if (defId === 'plant') return 'small_plant_smooth_top'
  if (defId === 'plant_bushy') return 'small_plant_bushy_top'
  if (defId === 'plant_large') return 'large_plant_bushy' // 1×2: base = large_plant_smooth, top = large_plant_bushy
  if (defId === 'watercooler') return 'water_cooler_top'
  if (registry.has(base + '_top')) return base + '_top'
  return undefined
}

/** True if this object has a top layer; uses the same list as getTwoPartTopSliceName + chair. */
export function objectHasTopLayer(defId: string): boolean {
  return (TOP_LAYER_DEF_IDS as readonly string[]).includes(defId)
}

export function getSheetUrl(): string {
  return SPRITE_SHEET_URL
}

/** All registered sprite names (atlas frame names + workstation_bottom/top). */
export function getAllSpriteNames(): string[] {
  return Array.from(registry.keys())
}

/** Agent sprites from workstation_atlas (agent_*_body; same sheet as office-assets.png). */
export function getAgentSprite(role: string): SpriteEntry | undefined {
  const base = ROLE_TO_AGENT_FRAME[role]
  if (!base) return undefined
  return registry.get(base + '_body')
}

/** Optional hair slice for two-part agent rendering (agent_*_hair from workstation_atlas). */
export function getAgentHairSprite(role: string): SpriteEntry | undefined {
  const base = ROLE_TO_AGENT_FRAME[role]
  if (!base) return undefined
  return registry.get(base + '_hair')
}
