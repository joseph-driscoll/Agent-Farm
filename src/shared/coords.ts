// src/shared/coords.ts
// Coordinate convention: (0,0) top-left, y increases downward (engine and agents).
// Legacy conversions (only if needed elsewhere):
export function toDisplayY(engineY: number, gridHeight: number): number {
  return gridHeight - 1 - engineY
}

export function toEngineY(displayY: number, gridHeight: number): number {
  return gridHeight - 1 - displayY
}
