import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { GridView } from './GridView'
import { useBreakpoint } from './useBreakpoint'
import { GridViewPixi } from './GridViewPixi'
import { Controls } from './Controls'
import { ActivityPanel } from './ActivityPanel'
import { AgentInspectorPanel } from './AgentInspectorPanel'
import { PlaceItemTool } from './PlaceItemTool'
import type { WorldState } from '../engine/schemas'
import {
  canPlaceAt,
  getChairPlacementCell,
  getComputerPlacementCell,
  getDeskSlotsInOrder,
  getItemDef,
  getPlacementFailureReason,
  getPlannedCellsFromProposals,
  getSlotCompletion,
} from '../engine/worldState'
import { CELL_PX, CELL_PX_Y } from '../config/spriteRegistry'

const WORLD_URL = '/api/world'
/** When true (default), the grid is rendered by GridViewPixi (Pixi canvas + HTML overlay). When false, uses GridView (HTML/CSS only). */
const USE_PIXI_GRID = (import.meta.env.VITE_USE_PIXI_GRID ?? '1') !== '0'
const WS_URL = (() => {
  if (typeof window === 'undefined') return 'ws://localhost:3011/ws'
  // In dev (Vite on 5173), connect directly to runtime to avoid WS proxy errors (localhost or 127.0.0.1)
  const isDev = window.location.port === '5173'
  const host = window.location.hostname
  if (isDev && (host === 'localhost' || host === '127.0.0.1')) {
    return `ws://${host}:3011/ws`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
})()

function App() {
  const { isNarrow, isPhone, isPhoneOrTablet } = useBreakpoint()
  const [world, setWorld] = useState<WorldState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(500)
  const [connectionStatus, setConnectionStatus] = useState<'polling' | 'connecting' | 'live'>('polling')
  const gridStageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const [showGrid, setShowGrid] = useState(false)
  const [showCellCoordinates, setShowCellCoordinates] = useState(false)
  const [placeToolOpen, setPlaceToolOpen] = useState(false)
  const [selectedDefId, setSelectedDefId] = useState<string | null>(null)
  const [deleteMode, setDeleteMode] = useState(false)
  const [placeError, setPlaceError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [agentInspectorExpanded, setAgentInspectorExpanded] = useState(true)
  const [proposalsExpanded, setProposalsExpanded] = useState(true)

  // When place item opens, collapse agent inspector and proposals so the place item menu is easier to see
  useEffect(() => {
    if (placeToolOpen) {
      setAgentInspectorExpanded(false)
      setProposalsExpanded(false)
    }
  }, [placeToolOpen])

  const plannedCells = useMemo(
    () => (world ? getPlannedCellsFromProposals(world) : []),
    [world]
  )

  const handleCellClickForPlace = useCallback(
    async (x: number, y: number) => {
      if (!selectedDefId || !world) return
      setPlaceError(null)
      let placeX = x
      let placeY = y
      if (selectedDefId === 'chair') {
        const cell = getChairPlacementCell(world, x, y)
        placeX = cell.x
        placeY = cell.y
      } else if (selectedDefId === 'computer') {
        const cell = getComputerPlacementCell(world, x, y)
        placeX = cell.x
        placeY = cell.y
      } else {
        const def = getItemDef(world, selectedDefId)
        const [w, h] = def?.footprint ?? [1, 1]
        // For any multi-cell item, treat the hovered cell as the bottom-left of the footprint.
        // Engine uses (placeX, placeY) as the top-left origin, so shift Y up by h-1.
        if (w > 1 || h > 1) {
          placeY = y - h + 1
        }
      }
      if (!canPlaceAt(world, selectedDefId, placeX, placeY, { allowPerimeterWallTop: true })) {
        setPlaceError(getPlacementFailureReason(world, selectedDefId, placeX, placeY) || 'Cannot place there')
        return
      }
      try {
        const res = await fetch('/api/human-place', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defId: selectedDefId, x: placeX, y: placeY }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.gridWidth != null) {
          setWorld(data as WorldState)
        } else {
          setPlaceError((data.error as string) || `Placement failed (${res.status})`)
        }
      } catch (e) {
        setPlaceError(e instanceof Error ? e.message : 'Network error')
      }
    },
    [selectedDefId, world]
  )

  const handleCellClickForDelete = useCallback(
    async (x: number, y: number) => {
      if (!world) return
      setPlaceError(null)
      try {
        const res = await fetch('/api/human-remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.gridWidth != null) {
          setWorld(data as WorldState)
        } else {
          setPlaceError((data.error as string) || `Remove failed (${res.status})`)
        }
      } catch (e) {
        setPlaceError(e instanceof Error ? e.message : 'Network error')
      }
    },
    [world]
  )

  useEffect(() => {
    let ro: ResizeObserver | null = null
    let rafId = 0
    const attachWhenReady = () => {
      const el = gridStageRef.current
      if (!el) {
        rafId = requestAnimationFrame(attachWhenReady)
        return
      }
      ro = new ResizeObserver(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          setStageSize({ w: el.clientWidth, h: el.clientHeight })
        }
      })
      ro.observe(el)
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setStageSize({ w: el.clientWidth, h: el.clientHeight })
      }
    }
    attachWhenReady()
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      ro?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (world && typeof window !== 'undefined') {
      ;(window as unknown as { __AGENT_FARM_WORLD__?: WorldState }).__AGENT_FARM_WORLD__ = world
    }
  }, [world])

  useEffect(() => {
    if (!world) return
    if (selectedAgentId && !world.agents.some((a) => a.id === selectedAgentId)) setSelectedAgentId(null)
  }, [world, selectedAgentId])

  // Initial world fetch (so UI paints immediately)
  useEffect(() => {
    fetch(WORLD_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        setWorld(data)
        setError(null)
      })
      .catch((e) => setError(e.message))
  }, [])

  // Polling fallback: if WebSocket never connects or drops, still get world updates every 8s
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(WORLD_URL)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.gridWidth === 'number') setWorld(data as WorldState)
        })
        .catch(() => {})
    }, 8000)
    return () => clearInterval(interval)
  }, [])

  // WebSocket: realtime world updates. Start once we have world (no delay — delay was cleared by React Strict Mode cleanup and prevented connect).
  const worldLoadedOnceRef = useRef(false)
  useEffect(() => {
    if (!world || worldLoadedOnceRef.current) return
    worldLoadedOnceRef.current = true
    function connect() {
      setConnectionStatus('connecting')
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => setConnectionStatus('live')
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          if (msg?.type === 'world' && msg.world && typeof msg.world.gridWidth === 'number') {
            setWorld(msg.world as WorldState)
            setError(null)
            setConnectionStatus('live')
            reconnectDelayRef.current = 500
          }
        } catch (_) {}
      }
      ws.onclose = () => {
        wsRef.current = null
        setConnectionStatus('polling')
        reconnectRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 1.5, 8000)
          connect()
        }, reconnectDelayRef.current)
      }
      ws.onerror = () => {}
    }
    connect()
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
    }
  }, [world])

  // On unmount only: close WebSocket and cancel reconnect
  useEffect(() => {
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0f0f1a',
          color: '#e8e8e8',
          fontFamily: 'system-ui, sans-serif',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 28, letterSpacing: '-0.5px' }}>Agent Farm</h1>
        <p style={{ margin: 0, color: '#888' }}>Runtime not reachable. Start it with: <code style={{ background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>npm run dev:runtime</code></p>
        <p style={{ color: '#ff6b6b', fontSize: 14 }}>{error}</p>
      </div>
    )
  }

  if (!world) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0f0f1a',
          color: '#e8e8e8',
          fontFamily: 'system-ui, sans-serif',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 28, letterSpacing: '-0.5px' }}>Agent Farm</h1>
        <p style={{ margin: '8px 0 0 0', color: '#888' }}>Loading world…</p>
      </div>
    )
  }

  const gridW = world.gridWidth * CELL_PX
  const gridH = world.gridHeight * CELL_PX_Y
  const targetWorkstations = Math.max(1, world.agents.length)
  const workstationCount = world.items.filter((i) => i.defId === 'workstation').length
  const deskSlots = getDeskSlotsInOrder(world)
  const completed = deskSlots.reduce(
    (acc, slot) => {
      const c = getSlotCompletion(world, slot)
      if (c.hasChair) acc.chairs++
      if (c.hasComputer) acc.computers++
      return acc
    },
    { chairs: 0, computers: 0 }
  )
  const totalSlots = deskSlots.length
  const executed = new Set(world.executedProposalIds ?? [])
  const rejected = new Set(world.rejectedProposalIds ?? [])
  const proposalArtifacts = (world.artifacts ?? []).filter((a) => a.type === 'Proposal')
  const queuedProposals = proposalArtifacts.filter((a) => !executed.has(a.id) && !rejected.has(a.id))
  const shippedProposals = proposalArtifacts.filter((a) => executed.has(a.id))
  const queueCount = (world.artifacts ?? []).filter(
    (a) => a.type === 'Proposal' && !executed.has(a.id) && !rejected.has(a.id)
  ).length
  const pipelinePhase =
    workstationCount < targetWorkstations
      ? {
          label: 'Phase 1: Workstations',
          detail: `${workstationCount}/${targetWorkstations} desks`,
          color: '#60a5fa',
          bg: 'rgba(96,165,250,0.2)',
        }
      : totalSlots > 0 && completed.chairs < totalSlots
        ? {
            label: 'Phase 2: Chairs',
            detail: `${completed.chairs}/${totalSlots} slots`,
            color: '#fbbf24',
            bg: 'rgba(251,191,36,0.2)',
          }
        : totalSlots > 0 && completed.computers < totalSlots
          ? {
              label: 'Phase 3: Computers',
              detail: `${completed.computers}/${totalSlots} slots`,
              color: '#34d399',
              bg: 'rgba(52,211,153,0.2)',
            }
          : {
              label: 'Phase 4: Amenities',
              detail: `queue ${queueCount}`,
              color: '#c4b5fd',
              bg: 'rgba(196,181,253,0.2)',
            }
  const minScale = isPhone ? 0.2 : isNarrow ? 0.35 : 0.5
  const scale =
    stageSize.w > 0 && stageSize.h > 0 && gridH > 0
      ? Math.max(minScale, Math.min(stageSize.w / gridW, stageSize.h / gridH))
      : 1

  return (
    <div
      style={{
        height: '100vh',
        maxHeight: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f0f1a',
        color: '#e8e8e8',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header: left = title + controls; right = tick + phase nav */}
      <header
        style={{
          flexShrink: 0,
          padding: isPhone ? '8px 10px' : isNarrow ? '10px 12px' : '12px 16px',
          borderBottom: '1px solid #1e2030',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: isPhone ? 8 : 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: isPhone ? 8 : 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: isPhone ? 16 : isNarrow ? 18 : 22, letterSpacing: '-0.5px' }}>Agent Farm</h1>
            <p style={{ margin: '2px 0 0 0', fontSize: isPhone ? 11 : 13, color: '#888' }}>
              Living Office — Nova, Sage & Pixel evolving the space.
              {(world as WorldState & { mode?: string; modeNote?: string }).mode === 'stub' && (
                <span
                  style={{
                    display: 'inline-block',
                    marginLeft: 8,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: 'rgba(248, 113, 113, 0.15)',
                    color: '#fca5a5',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                  title={(world as WorldState & { modeNote?: string }).modeNote}
                >
                  Stub mode — LLM off
                </span>
              )}
              {(world as WorldState & { mode?: string; modeNote?: string }).mode === 'llm' && (
                <span
                  style={{
                    display: 'inline-block',
                    marginLeft: 8,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: 'rgba(78, 205, 196, 0.2)',
                    color: '#5eead4',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                  title={(world as WorldState & { modeNote?: string }).modeNote}
                >
                  LLM on
                </span>
              )}
            </p>
          </div>
          <Controls
            showGrid={showGrid}
            onToggleGrid={() => setShowGrid((v) => !v)}
            showCellCoordinates={showCellCoordinates}
            onToggleCellCoordinates={() => setShowCellCoordinates((v) => !v)}
            llmEnabled={(world as WorldState & { mode?: string }).mode !== 'stub'}
            onToggleLlm={() =>
              setWorld((w) => {
                if (!w) return w
                const ext = w as WorldState & { mode?: string }
                return { ...w, mode: ext.mode === 'stub' ? 'llm' : 'stub' } as WorldState
              })
            }
          />
          <button
            type="button"
            onClick={() => {
              setPlaceToolOpen((v) => !v)
              if (placeToolOpen) setSelectedDefId(null)
              setPlaceError(null)
              if (!placeToolOpen) setDeleteMode(false)
            }}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #334155',
              background: placeToolOpen ? 'rgba(78, 205, 196, 0.2)' : 'transparent',
              color: placeToolOpen ? '#5eead4' : '#94a3b8',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Place item
          </button>
          <button
            type="button"
            onClick={() => {
              setDeleteMode((v) => !v)
              if (!deleteMode) {
                setPlaceToolOpen(false)
                setSelectedDefId(null)
                setPlaceError(null)
              }
            }}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #334155',
              background: deleteMode ? 'rgba(239, 68, 68, 0.25)' : 'transparent',
              color: deleteMode ? '#f87171' : '#94a3b8',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Delete Item
          </button>
        </div>
        {/* Top right nav: tick, scores, connection, phase */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: isPhone ? 6 : 10,
            flexWrap: 'wrap',
            marginLeft: 'auto',
            padding: isPhone ? '4px 6px' : '6px 10px',
            background: 'rgba(26, 26, 46, 0.9)',
            borderRadius: 6,
            border: '1px solid #2a2a4a',
            fontSize: isPhone ? 10 : 12,
            color: '#888',
          }}
        >
          <span>
            Tick {world.tick} · P {world.scores.power.toFixed(0)} A {world.scores.aesthetic.toFixed(0)} C {world.scores.collaboration.toFixed(0)} − W {world.scores.wastePenalty}
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              background: connectionStatus === 'live' ? 'rgba(34, 197, 94, 0.25)' : connectionStatus === 'connecting' ? 'rgba(234, 179, 8, 0.25)' : 'rgba(148, 163, 184, 0.25)',
              color: connectionStatus === 'live' ? '#4ade80' : connectionStatus === 'connecting' ? '#facc15' : '#94a3b8',
            }}
            title={connectionStatus === 'live' ? 'WebSocket connected' : connectionStatus === 'connecting' ? 'Connecting…' : 'Using polling (8s)'}
          >
            {connectionStatus === 'live' ? 'Live' : connectionStatus === 'connecting' ? '…' : 'Polling'}
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              background: pipelinePhase.bg,
              color: pipelinePhase.color,
            }}
            title={`${pipelinePhase.label} — ${pipelinePhase.detail}`}
          >
            {pipelinePhase.label} · {pipelinePhase.detail}
          </span>
        </div>
      </header>

      {/* Main: side panels + grid stage. Row on wide; column (grid then panels) on narrow. */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: isNarrow ? 'column' : 'row',
          overflow: 'hidden',
        }}
      >
        {!isNarrow && (
          <aside style={{ flexShrink: 0 }}>
            <ActivityPanel world={world} responsiveWidth={isPhoneOrTablet ? 240 : 260} />
          </aside>
        )}

        {/* Grid stage: fixed-pixel grid scaled to fit */}
        <div
          ref={gridStageRef}
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
            background: '#0d0d14',
          }}
        >
          {placeError && (
            <div
              style={{
                position: 'absolute',
                bottom: 40,
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '8px 14px',
                background: 'rgba(239, 68, 68, 0.2)',
                border: '1px solid #ef4444',
                borderRadius: 8,
                color: '#fca5a5',
                fontSize: 13,
                zIndex: 60,
              }}
            >
              {placeError}
            </div>
          )}
          <div
            style={{
              flexShrink: 0,
              width: gridW,
              height: gridH,
              transform: `scale(${scale})`,
              transformOrigin: 'center center',
              imageRendering: 'pixelated',
            }}
          >
            {USE_PIXI_GRID ? (
              <GridViewPixi
                world={world}
                showGrid={showGrid}
                showCellCoordinates={showCellCoordinates}
                onAgentClick={(agentId) => setSelectedAgentId(agentId)}
                selectedAgentId={selectedAgentId}
                onCellClick={
                  deleteMode
                    ? handleCellClickForDelete
                    : placeToolOpen && selectedDefId
                      ? handleCellClickForPlace
                      : undefined
                }
                selectedDefId={selectedDefId}
                placeToolOpen={placeToolOpen}
                deleteMode={deleteMode}
                plannedCells={plannedCells}
              />
            ) : (
              <GridView
                world={world}
                showGrid={showGrid}
                showCellCoordinates={showCellCoordinates}
                onAgentClick={(agentId) => setSelectedAgentId(agentId)}
                selectedAgentId={selectedAgentId}
                onCellClick={
                  deleteMode
                    ? handleCellClickForDelete
                    : placeToolOpen && selectedDefId
                      ? handleCellClickForPlace
                      : undefined
                }
                selectedDefId={selectedDefId}
                placeToolOpen={placeToolOpen}
                deleteMode={deleteMode}
                plannedCells={plannedCells}
              />
            )}
          </div>
        </div>

        {/* Right pane (or below grid on narrow) */}
        <aside
          className="RightPane-scroll"
          style={{
            flexShrink: 0,
            width: isNarrow ? '100%' : isPhone ? 280 : isPhoneOrTablet ? 300 : 320,
            minWidth: isNarrow ? undefined : 240,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: isNarrow ? '8px' : '0 8px',
            maxHeight: isNarrow ? '45vh' : undefined,
          }}
        >
          <style>{`.RightPane-scroll::-webkit-scrollbar { display: none } .RightPane-scroll { -ms-overflow-style: none; scrollbar-width: none }`}</style>

          {isNarrow && (
            <aside style={{ flexShrink: 0, marginBottom: 8 }}>
              <ActivityPanel world={world} fullWidth />
            </aside>
          )}

          {/* Agent Inspector (collapsible) */}
          <div
            style={{
              width: '100%',
              maxWidth: 320,
              flexShrink: 0,
              background: '#161625',
              border: '1px solid #2a2a3e',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setAgentInspectorExpanded((e) => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                background: 'transparent',
                border: 'none',
                color: '#ccc',
                cursor: 'pointer',
                fontSize: 14,
                textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600 }}>Agent Inspector</span>
              <span style={{ fontSize: 10, color: '#94a3b8' }}>{agentInspectorExpanded ? '▼' : '▶'}</span>
            </button>
            {agentInspectorExpanded && (
              <AgentInspectorPanel
                world={world}
                selectedAgentId={selectedAgentId}
                onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
                hideTitle
              />
            )}
          </div>

          {/* Proposals (collapsible) */}
          <div
            style={{
              width: '100%',
              maxWidth: 320,
              flexShrink: 0,
              background: '#161625',
              border: '1px solid #2a2a3e',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setProposalsExpanded((e) => !e)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                background: 'transparent',
                border: 'none',
                color: '#ccc',
                cursor: 'pointer',
                fontSize: 14,
                textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600 }}>Proposals</span>
              <span style={{ fontSize: 10, color: '#94a3b8' }}>{proposalsExpanded ? '▼' : '▶'}</span>
            </button>
            {proposalsExpanded && (
              <div
                style={{
                  width: '100%',
                  flexShrink: 0,
                  background: '#161625',
                  border: 'none',
                  borderTop: '1px solid #2a2a3e',
                  maxHeight: 260,
                  overflow: 'auto',
                  padding: 12,
                  color: '#cbd5e1',
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>
                      Queued ({queuedProposals.length})
                    </div>
                    {queuedProposals.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#64748b' }}>No queued items.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {queuedProposals.slice(-8).reverse().map((proposal) => {
                          const payload = proposal.payload as { defId?: string; x?: number; y?: number }
                          const def = payload.defId ? getItemDef(world, payload.defId) : null
                          const label = def?.name ?? payload.defId ?? proposal.title ?? 'Proposal'
                          const hasPoint = payload.x != null && payload.y != null
                          return (
                            <div
                              key={`queued-${proposal.id}`}
                              style={{
                                fontSize: 12,
                                background: '#1d1d2d',
                                border: '1px solid #2f2f46',
                                borderRadius: 6,
                                padding: '6px 8px',
                              }}
                              title={proposal.id}
                            >
                              <div style={{ fontWeight: 600 }}>{label}</div>
                              {hasPoint && (
                                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                                  ({payload.x}, {payload.y})
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>
                      Shipped ({shippedProposals.length})
                    </div>
                    {shippedProposals.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#64748b' }}>No shipped items.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {shippedProposals.slice(-8).reverse().map((proposal) => {
                          const payload = proposal.payload as { defId?: string; x?: number; y?: number }
                          const def = payload.defId ? getItemDef(world, payload.defId) : null
                          const label = def?.name ?? payload.defId ?? proposal.title ?? 'Proposal'
                          const hasPoint = payload.x != null && payload.y != null
                          return (
                            <div
                              key={`shipped-${proposal.id}`}
                              style={{
                                fontSize: 12,
                                background: '#172029',
                                border: '1px solid #28556e',
                                borderRadius: 6,
                                padding: '6px 8px',
                              }}
                              title={proposal.id}
                            >
                              <div style={{ fontWeight: 600, color: '#7dd3fc' }}>{label}</div>
                              {hasPoint && (
                                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                                  ({payload.x}, {payload.y})
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          {placeToolOpen && (
            <PlaceItemTool
              selectedDefId={selectedDefId}
              onSelectDef={setSelectedDefId}
              onClose={() => {
                setPlaceToolOpen(false)
                setSelectedDefId(null)
                setPlaceError(null)
              }}
            />
          )}
        </aside>
      </main>

    </div>
  )
}

export default App
