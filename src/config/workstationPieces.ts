/**
 * Workstation pieces are slices from workstation_atlas.json (Aseprite export).
 * All sprite positions come from the JSON — when you move sprites on the sheet,
 * re-export the atlas so workstation_atlas.json matches office-assets.png. Same image.
 */

import workstationAtlasData from './workstation_atlas.json'

export type SpriteRegion = { x: number; y: number; w: number; h: number }

/**
 * Grid footprint is 5×2 cells. Atlas: top (1 row), bottom (1 row; slice width from JSON, not stretched to 5 cells).
 */
export const WORKSTATION_GRID_W_PX = 5 * 16
export const WORKSTATION_GRID_H_PX = 2 * 16

function getSliceBounds(name: string): SpriteRegion | null {
  const slices = (workstationAtlasData as { meta?: { slices?: Array<{ name: string; keys: Array<{ bounds: { x: number; y: number; w: number; h: number } }> }> } }).meta?.slices
  const slice = slices?.find((s) => s.name === name)
  const bounds = slice?.keys?.[0]?.bounds
  return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null
}

/** Workstation top slice (1 row). Uses workstation_atlas.json; fallback only if slice missing. */
export const WORKSTATION_TOP_REGION: SpriteRegion =
  getSliceBounds('workstation_top') ?? { x: 160, y: 80, w: 80, h: 16 }

/** Workstation bottom/desk slice (1 row; width from atlas, not stretched). Uses workstation_atlas.json; fallback only if slice missing. */
export const WORKSTATION_BOTTOM_REGION: SpriteRegion =
  getSliceBounds('workstation_bottom') ?? { x: 176, y: 96, w: 48, h: 16 }