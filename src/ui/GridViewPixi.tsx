import { useEffect, useMemo, useRef, useState } from 'react'
import { Application, Assets, Graphics, Texture } from 'pixi.js'
import type { WorldState } from '../engine/schemas'
import {
  BACK_WALL_ROWS,
  getAgentFacingWhenOnChair,
  getChairAtlasName,
  getChairFlipped,
  getComputerAtlasName,
  getDeletablePlacementCells,
  getItemDef,
  getValidPlacementTiles,
  hasWorkstationDirectlyAbove,
  hasWorkstationAt,
  isWorkstationTopCornerCell,
  isStructuralWallPiece,
} from '../engine/worldState'
import {
  CELL_PX,
  CELL_PX_Y,
  getAgentHairSprite,
  getAgentSprite,
  getSheetUrl,
  getSprite,
  getTwoPartTopSliceName,
  objectHasTopLayer,
} from '../config/spriteRegistry'
import { useClientMotion } from '../runtime/clientMotion'
import { createPixiLayers } from './pixi/layers'
import { createSpriteFromEntry } from './pixi/spriteFactory'
import { WORKSTATION_BOTTOM_REGION, WORKSTATION_TOP_REGION } from '../config/workstationPieces'

const BG = 0x12121c
const WALL_ROW = 0x2d3142
const FLOOR_ROW = 0x1e2030
const CANVAS_BORDER = '#3d4451'
const BUBBLE_TTL_MS = 4_000
const WORKSTATION_Z = 10
const WORKSTATION_DESK_Z = 11
const COMPUTER_Z = 12
const CHAIR_BASE_Z = 11
const CHAIR_TOP_Z = 12
const ITEM_BASE_Z = 8
const AGENT_Z = 30
const TOP_LAYER_Z = 35
const AGENT_BEHIND_DESK_Z = 8

interface GridViewPixiProps {
  world: WorldState
  showGrid?: boolean
  showCellCoordinates?: boolean
  onCellClick?: (x: number, y: number) => void
  selectedDefId?: string | null
  placeToolOpen?: boolean
  deleteMode?: boolean
  onAgentClick?: (agentId: string) => void
  selectedAgentId?: string | null
  /** Cells from queued proposals (planned section) to highlight */
  plannedCells?: Array<{ x: number; y: number }>
}

function clearContainerChildren(container: { removeChildren: () => unknown[] } | null | undefined): void {
  if (!container) return
  const removed = container.removeChildren()
  for (const child of removed as Array<{ destroy?: (opts?: unknown) => void }>) {
    if (!child || typeof child.destroy !== 'function') continue
    try {
      // Children are fully transient per frame; keep shared textures alive in cache.
      child.destroy({ children: true, texture: false, textureSource: false })
    } catch {
      child.destroy()
    }
  }
}

export function GridViewPixi({
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
}: GridViewPixiProps) {
  const { gridWidth, gridHeight, items, agents, chatLog = [] } = world
  const mountRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const layersRef = useRef<ReturnType<typeof createPixiLayers> | null>(null)
  const [appReady, setAppReady] = useState(false)
  const [bubbleTick, setBubbleTick] = useState(0)
  const { displayPositions, agentFacing, chairCellFrames } = useClientMotion(world)

  const gridW = Math.round(gridWidth * CELL_PX)
  const gridH = Math.round(gridHeight * CELL_PX_Y)

  const showSkeleton = Boolean(placeToolOpen && selectedDefId && !['chair', 'computer'].includes(selectedDefId))
  const [previewCell, setPreviewCell] = useState<{ x: number; y: number } | null>(null)

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

  useEffect(() => {
    let cancelled = false
    const mount = mountRef.current
    if (!mount || appRef.current) return

    const start = async () => {
      await Assets.load(getSheetUrl())
      const sheet = Assets.get(getSheetUrl()) as Texture | undefined
      if (sheet?.source) sheet.source.scaleMode = 'nearest'
      const app = new Application()
      await app.init({
        width: gridW,
        height: gridH,
        backgroundColor: BG,
        antialias: false,
        preference: 'webgl',
        resolution: 1,
        autoDensity: false,
        roundPixels: true,
      })
      if (cancelled) {
        app.destroy()
        return
      }
      appRef.current = app
      const layers = createPixiLayers()
      layersRef.current = layers
      app.stage.addChild(layers.root)
      mount.appendChild(app.canvas)
      setAppReady(true)
    }

    start()
    return () => {
      cancelled = true
      const app = appRef.current
      if (app) {
        const existingLayers = layersRef.current
        if (existingLayers) {
          clearContainerChildren(existingLayers.background)
          clearContainerChildren(existingLayers.items)
          clearContainerChildren(existingLayers.agents)
          clearContainerChildren(existingLayers.foreground)
          clearContainerChildren(existingLayers.overlays)
        }
        app.destroy(true, true)
        appRef.current = null
      }
      layersRef.current = null
      setAppReady(false)
    }
  }, [gridW, gridH])

  useEffect(() => {
    const app = appRef.current
    const layers = layersRef.current
    if (!app || !layers) return

    app.renderer.resize(gridW, gridH)
    clearContainerChildren(layers.background)
    clearContainerChildren(layers.items)
    clearContainerChildren(layers.agents)
    clearContainerChildren(layers.foreground)
    clearContainerChildren(layers.overlays)

    for (let y = 0; y < BACK_WALL_ROWS; y++) {
      const g = new Graphics().rect(0, Math.round(y * CELL_PX_Y), gridW, Math.round(CELL_PX_Y)).fill(WALL_ROW)
      layers.background.addChild(g)
    }
    const floor = new Graphics()
      .rect(0, Math.round(BACK_WALL_ROWS * CELL_PX_Y), gridW, Math.round((gridHeight - BACK_WALL_ROWS) * CELL_PX_Y))
      .fill(FLOOR_ROW)
    layers.background.addChild(floor)

    for (const c of world.cells ?? []) {
      if (c.kind !== 'floor' || c.floorFromSlice) continue
      const cover = new Graphics()
        .rect(Math.round(c.x * CELL_PX), Math.round(c.y * CELL_PX_Y), CELL_PX, CELL_PX_Y)
        .fill(FLOOR_ROW)
      layers.background.addChild(cover)
    }

    const sheetUrl = getSheetUrl()
    void sheetUrl

    for (const item of items) {
      const def = getItemDef(world, item.defId)
      if (!def) continue
      const [fw, fh] = def.footprint
      const baseX = item.x * CELL_PX
      const baseY = item.y * CELL_PX_Y

      if (item.defId === 'workstation') {
        const top = getSprite('workstation_top')
        const bottom = getSprite('workstation_bottom')
        if (top) {
          const t = WORKSTATION_TOP_REGION
          const b = WORKSTATION_BOTTOM_REGION
          const cellH = CELL_PX_Y
          const boxW = fw * CELL_PX
          const hasAbove = hasWorkstationDirectlyAbove(world, item)
          const topDrawH = hasAbove ? cellH + 1 : cellH
          const topScaleX = boxW / t.w
          const bottomW = Math.round(b.w * topScaleX)
          const bottomLeft = baseX + Math.round((b.x - t.x) * topScaleX)
          const s = createSpriteFromEntry(top, boxW, topDrawH)
          s.x = baseX
          s.y = baseY
          s.zIndex = WORKSTATION_Z
          layers.items.addChild(s)
          if (bottom) {
            const desk = createSpriteFromEntry(bottom, bottomW, cellH + 2)
            desk.x = bottomLeft
            desk.y = hasAbove ? baseY + cellH : baseY + cellH - 1
            desk.zIndex = WORKSTATION_DESK_Z
            layers.items.addChild(desk)
          }
        }
        continue
      }

      const spriteName =
        item.defId === 'chair'
          ? getChairAtlasName(world, item)
          : item.defId === 'computer'
            ? getComputerAtlasName(world, item)
            : undefined
      const entry = spriteName ? getSprite(spriteName) : getSprite(item.defId)
      if (!entry) continue

      const isTwoPartTall =
        Boolean(getTwoPartTopSliceName(item.defId)) &&
        (item.defId === 'plant' || item.defId === 'plant_bushy' || item.defId === 'plant_large' || item.defId === 'watercooler')

      let drawW = fw * CELL_PX
      let drawH = fh * CELL_PX_Y
      let drawX = baseX
      let drawY = baseY
      if (item.defId === 'computer') {
        drawW = CELL_PX * 2
        drawH = CELL_PX_Y * 2
        drawY = baseY - CELL_PX_Y
        const isRightComputer = getComputerAtlasName(world, item).endsWith('_right')
        if (isRightComputer) drawX = baseX - CELL_PX
      }
      if (isTwoPartTall) {
        // Two-part tall assets (plants/watercooler): base is one cell, top slice is one cell above.
        drawW = CELL_PX
        drawH = CELL_PX_Y
        drawX = baseX
        drawY = baseY
      }
      const sprite = createSpriteFromEntry(entry, drawW, drawH)
      sprite.x = drawX
      sprite.y = drawY
      const isMemoOnWorkstationCorner =
        (item.defId === 'post_its' || item.defId === 'wall_art_memo_a' || item.defId === 'wall_art_memo_b') &&
        isWorkstationTopCornerCell(world, item.x, item.y)
      const hasSeparateTopSlice = item.defId !== 'chair' && Boolean(getTwoPartTopSliceName(item.defId))
      if (item.defId === 'computer') {
        sprite.zIndex = COMPUTER_Z
      } else if (item.defId === 'chair') {
        sprite.zIndex = CHAIR_BASE_Z
      } else if (objectHasTopLayer(item.defId) && item.defId !== 'chair' && !hasSeparateTopSlice) {
        sprite.zIndex = TOP_LAYER_Z
      } else if (isMemoOnWorkstationCorner) {
        sprite.zIndex = CHAIR_TOP_Z
      } else {
        sprite.zIndex = ITEM_BASE_Z
      }
      if (item.defId === 'chair') {
        if (getChairFlipped(world, item.x, item.y)) {
          sprite.scale.x = -1
          sprite.x += CELL_PX
        }
      }
      const targetLayer = sprite.zIndex >= TOP_LAYER_Z ? layers.foreground : layers.items
      targetLayer.addChild(sprite)

      if (item.defId === 'chair') {
        const topEntry = getSprite(getChairAtlasName(world, item) + '_top')
        if (topEntry) {
          const chairTop = createSpriteFromEntry(topEntry, fw * CELL_PX, fh * CELL_PX_Y)
          const flipped = getChairFlipped(world, item.x, item.y)
          chairTop.x = flipped ? baseX + CELL_PX : baseX
          chairTop.y = baseY - CELL_PX_Y
          chairTop.zIndex = CHAIR_TOP_Z
          if (flipped) chairTop.scale.x = -1
          layers.items.addChild(chairTop)
        }
      }

      const topSliceName = item.defId === 'chair' ? undefined : getTwoPartTopSliceName(item.defId)
      if (topSliceName) {
        const topEntry = getSprite(topSliceName)
        if (topEntry) {
          const top = createSpriteFromEntry(topEntry, CELL_PX, CELL_PX_Y)
          top.x = baseX
          top.y = baseY - CELL_PX_Y
          top.zIndex = TOP_LAYER_Z
          layers.foreground.addChild(top)
        }
      }
    }

    for (const a of [...agents].sort((aa, bb) => {
      const posA = displayPositions[aa.id] ?? { x: aa.x, y: aa.y }
      const posB = displayPositions[bb.id] ?? { x: bb.x, y: bb.y }
      return posA.y !== posB.y ? posA.y - posB.y : posA.x - posB.x
    })) {
      const pos = displayPositions[a.id] ?? { x: a.x, y: a.y }
      const cellX = Math.floor(pos.x)
      const cellY = Math.floor(pos.y)
      const px = Math.round(pos.x * CELL_PX)
      const py = Math.round(pos.y * CELL_PX_Y)
      const body = getAgentSprite(a.role)
      const hair = getAgentHairSprite(a.role)
      const facing = agentFacing[a.id] ?? 'right'
      const onChairCell = getAgentFacingWhenOnChair(world, cellX, cellY) != null
      const onWorkstationCell = hasWorkstationAt(world, cellX, cellY)
      const renderBehindDesk = onWorkstationCell && !onChairCell
      const container = renderBehindDesk ? layers.items : layers.agents

      const bodyR = body?.region
      const hairR = hair?.region
      const bodyW = bodyR ? (bodyR.w / 16) * CELL_PX : CELL_PX
      const bodyH = bodyR ? (bodyR.h / 16) * CELL_PX_Y : CELL_PX_Y
      const hairW = hairR ? (hairR.w / 16) * CELL_PX : bodyW
      const hairH = hairR ? (hairR.h / 16) * CELL_PX_Y : bodyH
      const combinedW = Math.max(CELL_PX, bodyW, hairW)
      const combinedH = (hair ? hairH : 0) + bodyH
      const left = px - combinedW / 2
      const top = py + CELL_PX_Y / 2 - combinedH

      if (body) {
        const bodySprite = createSpriteFromEntry(body, bodyW, bodyH)
        bodySprite.x = left + (combinedW - bodyW) / 2
        bodySprite.y = top + (hair ? hairH : 0)
        if (facing === 'left') {
          bodySprite.scale.x = -1
          bodySprite.x += bodyW
        }
        bodySprite.zIndex = (renderBehindDesk ? AGENT_BEHIND_DESK_Z : AGENT_Z) + py / 10_000
        container.addChild(bodySprite)
      }
      if (hair) {
        const hairSprite = createSpriteFromEntry(hair, hairW, hairH)
        hairSprite.x = left + (combinedW - hairW) / 2
        hairSprite.y = top
        if (facing === 'left') {
          hairSprite.scale.x = -1
          hairSprite.x += hairW
        }
        hairSprite.zIndex = (renderBehindDesk ? AGENT_BEHIND_DESK_Z + 0.1 : AGENT_Z + 0.1) + py / 10_000
        container.addChild(hairSprite)
      }
    }
  }, [agents, appReady, displayPositions, gridH, gridHeight, gridW, items, world, agentFacing])

  return (
    <div
      style={{
        width: gridW,
        height: gridH,
        background: '#12121c',
        border: `1px solid ${CANVAS_BORDER}`,
        boxSizing: 'border-box',
        overflow: 'hidden',
        position: 'relative',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        imageRendering: 'pixelated',
      }}
      onMouseLeave={() => showSkeleton && setPreviewCell(null)}
    >
      <div ref={mountRef} style={{ width: gridW, height: gridH, position: 'relative', zIndex: 32 }} />

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
              zIndex: 33,
            }}
            title="Planned (in build queue)"
          />
        ))}

      {showGrid && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: gridW,
            height: gridH,
            pointerEvents: 'none',
            zIndex: 36,
            backgroundImage: `repeating-linear-gradient(90deg, rgba(180,140,255,0.25) 0px, rgba(180,140,255,0.25) 1px, transparent 1px, transparent ${CELL_PX}px), repeating-linear-gradient(0deg, rgba(180,140,255,0.25) 0px, rgba(180,140,255,0.25) 1px, transparent 1px, transparent ${CELL_PX_Y}px)`,
            backgroundPosition: '-1px 0, 0 0',
          }}
        />
      )}

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
              zIndex: 34,
            }}
          />
        ))}

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
                zIndex: 40,
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
              zIndex: 41,
              boxSizing: 'border-box',
            }}
          />
        )
      })()}

      {showCellCoordinates && Array.from({ length: gridHeight }, (_, y) =>
        Array.from({ length: gridWidth }, (_, x) => (
          <div
            key={`cell-${x}-${y}`}
            style={{
              position: 'absolute',
              left: x * CELL_PX + 1,
              top: y * CELL_PX_Y + 11,
              fontSize: 4,
              fontWeight: 400,
              color: '#fff',
              fontFamily: 'system-ui, monospace',
              pointerEvents: 'none',
              zIndex: 36,
            }}
            title={`(${x}, ${y}) — top-left is (0,0)`}
          >
            {x},{y}
          </div>
        ))
      )}

      {/* Agent overlays: click target + say bubble/icons */}
      {agents.map((a) => {
        const pos = displayPositions[a.id] ?? { x: a.x, y: a.y }
        const cellX = Math.floor(pos.x)
        const cellY = Math.floor(pos.y)
        const px = Math.round(pos.x * CELL_PX)
        const py = Math.round(pos.y * CELL_PX_Y)
        const say = lastSayByAgent.get(a.id)
        const chairFacing = getAgentFacingWhenOnChair(world, cellX, cellY)
        const settledInChair = (chairCellFrames[a.id] ?? 0) >= 6
        const agentClickable = Boolean(onAgentClick && !onCellClick)
        const agentSelected = selectedAgentId === a.id
        return (
          <div
            key={`agent-ui-${a.id}`}
            style={{
              position: 'absolute',
              left: px - 80,
              top: py + 8,
              width: 160,
              pointerEvents: 'none',
              zIndex: 50,
              textAlign: 'center',
            }}
          >
            {agentClickable && (
              <button
                type="button"
                onClick={() => onAgentClick?.(a.id)}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: -28,
                  transform: 'translateX(-50%)',
                  width: 34,
                  height: 40,
                  borderRadius: 8,
                  border: agentSelected ? '1px solid #5eead4' : 'none',
                  background: agentSelected ? 'rgba(94,234,212,0.08)' : 'transparent',
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                }}
                title={`Inspect ${a.name}`}
              />
            )}
            {say && (
              <div
                style={{
                  display: 'inline-block',
                  minWidth: 64,
                  maxWidth: 160,
                  marginBottom: 2,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: 'rgba(24,24,36,0.95)',
                  border: '1px solid rgba(148,163,184,0.5)',
                  fontSize: 4,
                  lineHeight: 1.3,
                  color: '#e2e8f0',
                  fontFamily: 'monospace',
                  wordBreak: 'break-word',
                  textAlign: 'left',
                }}
                title={say}
              >
                {say.length > 80 ? `${say.slice(0, 77)}...` : say}
              </div>
            )}
            {chairFacing != null && settledInChair && a.name !== 'Nova' && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: -37,
                  transform: `translateX(calc(-50% + ${chairFacing === 'right' ? -12 : 14}px))${chairFacing === 'right' ? ' scaleX(-1)' : ''}`,
                  fontSize: 14,
                  lineHeight: 1,
                }}
                title="Thinking..."
              >
                💭
              </div>
            )}
            {a.name === 'Nova' && chairFacing != null && settledInChair && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: -42,
                  transform: 'translateX(-50%)',
                  fontSize: 14,
                  lineHeight: 1,
                }}
                title={(a.currentIntent ?? '') === 'research' ? 'Running Tavily research' : 'At computer — Tavily research'}
              >
                💡
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

