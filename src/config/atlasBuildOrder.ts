/**
 * Build progression and atlas context for agents.
 * Workstation = two sprites (top + bottom centered) from workstation_atlas.json.
 */

export const OFFICE_REFERENCE_IMAGE_URL = '/PixelOffice.png'

/**
 * Workstation rules: one placement (5×2). Two sprites — top and bottom, bottom centered under top.
 * Chair adjacent to workstation; computer can be placed on a workstation cell.
 */
export const WORKSTATION_RULES = [
  'Workstation: one placement, footprint 5×2. Two sprites (workstation_top, workstation_bottom) — bottom fits right against the top, centered.',
  'Chair: can ONLY be placed adjacent to a workstation (one of the four cells next to any workstation cell).',
  'Computer: can ONLY be placed on a workstation cell (overlaps one cell of the 5×2).',
  'HARD RULE — Even spacing: use the same aisle width between all workstation columns (all 2-cell or all 3-cell gaps, never mixed); keep equal space on left and right sides of the layout; stacks stay aligned in columns (same x, y ± 2).',
] as const

export const WORKSTATION_RULES_TEXT = WORKSTATION_RULES.join(' ')

export const BUILD_PROGRESSION: string[][] = [
  ['floor', 'wall_top', 'wall_top_left', 'wall_top_right', 'wall_left', 'wall_right', 'wall_bottom', 'wall_bottom_left', 'wall_bottom_right'],
  ['workstation'],
  ['chair'],
  ['computer'],
  ['table_large', 'table_small'],
  ['bookshelf'],
  ['plant', 'plant_bushy', 'plant_large', 'coffee_maker'],
  [
    'watercooler',
    'vending_machine',
    'trashcan',
    'couch',
    'wall_art',
    'wall_art_sun',
    'wall_art_sunset',
    'wall_art_sun_rise',
    'wall_art_usa_flag',
    'wall_art_england_flag',
    'wall_art_india_flag',
    'wall_art_memo_a',
    'wall_art_memo_b',
  ],
]

export const PLACEABLE_DEF_IDS_ORDERED: string[] = BUILD_PROGRESSION.flat()

/** Office atlas (office_atlas.json / PixelOfficeAssets-sheet) — all placeable defIds come from this atlas. */
export const OFFICE_ATLAS_SOURCE = 'office_atlas.json (PixelOfficeAssets-sheet)'

export const PHASE_LABELS: Record<string, string> = {
  floor: 'floor (paint tile)',
  workstation: 'workstation (5×2; two sprites: top + bottom centered)',
  chair: 'chair (adjacent to workstation)',
  computer: 'computer (on a workstation cell)',
  table_large: 'meeting table',
  table_small: 'small table',
  bookshelf: 'bookshelf / research area',
  plant: 'plant (smooth, 1×2)',
  plant_bushy: 'plant (bushy, 1×2)',
  plant_large: 'plant (large, 1×2)',
  coffee_maker: 'coffee maker',
  watercooler: 'water cooler',
  vending_machine: 'vending machine',
  trashcan: 'trash can',
  couch: 'couch',
  wall_art: 'wall art (calendar, 2×1)',
  wall_art_sun: 'wall art (sun)',
  wall_art_sunset: 'wall art (sunset)',
  wall_art_sun_rise: 'wall art (sun rise)',
  wall_art_usa_flag: 'wall art (USA flag)',
  wall_art_england_flag: 'wall art (England flag)',
  wall_art_india_flag: 'wall art (India flag)',
  wall_art_memo_a: 'wall art (memo A)',
  wall_art_memo_b: 'wall art (memo B)',
}

export function getPhaseLabel(defId: string): string {
  return PHASE_LABELS[defId] ?? defId
}

export const ITEM_IMPORTANCE_ORDER: string[] = [
  'workstation',
  'chair',
  'computer',
  'table_large', 'table_small',
  'bookshelf',
  'plant', 'plant_bushy', 'plant_large', 'coffee_maker',
  'watercooler', 'vending_machine', 'trashcan', 'couch',
  'wall_art',
  'floor',
  'wall_top', 'wall_top_left', 'wall_top_right', 'wall_left', 'wall_right', 'wall_bottom', 'wall_bottom_left', 'wall_bottom_right',
]

export const NO_WHITEBOARD_RULE =
  'There is NO whiteboard. Place workstations (5×2), then chairs adjacent to workstations and computers on workstation cells. Then table_large, bookshelf, plant, coffee_maker.'