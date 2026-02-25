/**
 * Left panel — unified Activity: chat (say) + pipeline actions (propose, vote, place)
 * so Activity, Whiteboard, and grid stay in sync with one source of truth (lastEvents).
 */

import { useState, useRef, useEffect } from 'react'
import type { WorldState } from '../engine/schemas'
import type { Action } from '../engine/schemas'
import { getItemDef, normalizeDefId, AGENT_IN_THE_WAY_REASON } from '../engine/worldState'
import { getDisplayNameForRole } from '../runtime/agentRoles'

const AGENT_COLORS: Record<string, string> = {
  Nova: '#ff6b6b',
  Sage: '#4ecdc4',
  Pixel: '#ffe66d',
}

/** Color for entries that came from an LLM/API call (every agent say and action is from a model response). */
const LLM_ENTRY_COLOR = '#a78bfa'

interface ActivityPanelProps {
  world: WorldState
  /** When set, use this width instead of default 260 (for responsive layouts). */
  responsiveWidth?: number
  /** When true, use 100% width (e.g. when stacked below grid on narrow viewports). */
  fullWidth?: boolean
}

type ActivityFilter = null | string

type UnifiedEntry =
  | { kind: 'say'; key: string; tick: number; eventIndex: number; agentName: string; agentRole?: string; text: string; timeLabel: string; fromLLM?: boolean }
  | { kind: 'action'; key: string; tick: number; eventIndex: number; agentName: string; agentRole?: string; text: string; muted?: boolean; fromLLM?: boolean }

function getAgentName(world: WorldState, agentId: string): string {
  return world.agents.find((a) => a.id === agentId)?.name ?? agentId
}

function getAgentRoleDisplay(world: WorldState, agentId: string): string | undefined {
  const agent = world.agents.find((a) => a.id === agentId)
  return agent ? getDisplayNameForRole(agent.role) : undefined
}

function formatActivityTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

/** Skip placeholder / non-messages so they never show in activity. */
function isPlaceholderSay(text: string): boolean {
  const t = text.trim()
  return t === '...' || t === '…'
}

/** Normalize for duplicate detection: lowercase, collapse whitespace, trim. */
function normalizeSayForDedupe(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** True if a and b are effectively the same say (exact or one contains the other after normalize). */
function isSameOrEchoSay(a: string, b: string): boolean {
  const na = normalizeSayForDedupe(a)
  const nb = normalizeSayForDedupe(b)
  if (na.length < 10 || nb.length < 10) return na === nb
  if (na === nb) return true
  return na.includes(nb) || nb.includes(na)
}

function buildUnifiedActivity(world: WorldState): UnifiedEntry[] {
  const events = world.lastEvents ?? []
  const chatById = new Map((world.chatLog ?? []).map((entry) => [entry.id, entry]))
  const out: UnifiedEntry[] = []
  for (const ev of events) {
    const key = `ev-${ev.tick}-${ev.eventIndex}`
    const action = ev.action as Action
    const agentId = 'agentId' in action ? action.agentId : ''
    const agentName = getAgentName(world, agentId)
    const agentRole = getAgentRoleDisplay(world, agentId)
    // Only agent actions (not human) are from LLM/API calls; human placement failures etc. must not show the LLM badge
    const fromLLM = agentId !== 'human' && agentId !== ''
    if (action.type === 'SAY' && action.text?.trim()) {
      const text = action.text.trim()
      if (isPlaceholderSay(text)) continue
      const prev = out[out.length - 1]
      if (prev?.kind === 'say' && prev.agentName === agentName && isSameOrEchoSay(prev.text, text)) continue
      const chatId = `chat-${ev.tick}-${ev.eventIndex}`
      const at = chatById.get(chatId)?.at
      out.push({
        kind: 'say',
        key,
        tick: ev.tick,
        eventIndex: ev.eventIndex,
        agentName,
        agentRole,
        text,
        timeLabel: typeof at === 'number' ? formatActivityTime(at) : `Tick ${ev.tick}`,
        fromLLM,
      })
      continue
    }
    if (action.type === 'THOUGHT' && action.text?.trim()) {
      const text = action.text.trim()
      if (isPlaceholderSay(text)) continue
      const prev = out[out.length - 1]
      if (prev?.kind === 'say' && prev.agentName === agentName && isSameOrEchoSay(prev.text, text)) continue
      const chatId = `chat-${ev.tick}-${ev.eventIndex}`
      const at = chatById.get(chatId)?.at
      out.push({
        kind: 'say',
        key,
        tick: ev.tick,
        eventIndex: ev.eventIndex,
        agentName,
        agentRole,
        text,
        timeLabel: typeof at === 'number' ? formatActivityTime(at) : `Tick ${ev.tick}`,
        fromLLM,
      })
      continue
    }
    if (action.type === 'CREATE_ARTIFACT' && action.artifactType === 'Proposal') {
      const p = action.payload as { defId?: string; x?: number; y?: number } | undefined
      const def = p?.defId ? getItemDef(world, p.defId) : null
      const label = def?.name ?? p?.defId ?? 'item'
      const at = p?.x != null && p?.y != null ? ` at (${p.x},${p.y})` : ''
      out.push({ kind: 'action', key, tick: ev.tick, eventIndex: ev.eventIndex, agentName, agentRole, text: `proposed ${label}${at}`, fromLLM })
      continue
    }
    if (action.type === 'VOTE') {
      const v = (action as { vote?: string }).vote === 'yes' ? 'yes' : 'no'
      out.push({ kind: 'action', key, tick: ev.tick, eventIndex: ev.eventIndex, agentName, agentRole, text: `voted ${v}`, fromLLM })
      continue
    }
    if (action.type === 'PLACE_ITEM') {
      const defId = normalizeDefId((action as { defId: string }).defId)
      const x = (action as { x: number }).x
      const y = (action as { y: number }).y
      // Only show "placed" once the item is in world.items so dialogue never gets ahead of the grid
      const itemExists = (world.items ?? []).some((i) => normalizeDefId(i.defId) === defId && i.x === x && i.y === y)
      if (itemExists) {
        const def = getItemDef(world, (action as { defId: string }).defId)
        const label = def?.name ?? (action as { defId: string }).defId
        out.push({ kind: 'action', key, tick: ev.tick, eventIndex: ev.eventIndex, agentName, agentRole, text: `placed ${label} at (${x},${y})`, fromLLM })
      }
      continue
    }
    if (action.type === 'FAIL_ACTION') {
      const reason = (action as { reason?: string }).reason ?? 'failed'
      // Skip "Agent in the way" — runtime moves builder off and retries; showing it repeatedly is noisy.
      if (reason === AGENT_IN_THE_WAY_REASON) continue
      out.push({ kind: 'action', key, tick: ev.tick, eventIndex: ev.eventIndex, agentName, agentRole, text: reason, muted: true, fromLLM })
    }
  }
  return out
}

export function ActivityPanel({ world, responsiveWidth, fullWidth }: ActivityPanelProps) {
  const [filter, setFilter] = useState<ActivityFilter>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const unified = buildUnifiedActivity(world)
  const names = [...new Set(unified.map((e) => e.agentName)).values()].filter(Boolean).sort()
  const visible = filter === null ? unified : unified.filter((e) => e.agentName === filter)
  const lastKey = visible[visible.length - 1]?.key

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastKey])

  const width = fullWidth ? '100%' : (responsiveWidth ?? 260)
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        background: '#161625',
        border: '1px solid #2a2a3e',
        maxHeight: 700,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid #2a2a3e', flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, color: '#ccc' }}>Activity</h3>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setFilter(null)}
            style={{
              padding: '2px 8px',
              fontSize: 10,
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              background: filter === null ? '#333' : 'transparent',
              color: filter === null ? '#ddd' : '#666',
            }}
          >
            All
          </button>
          {names.map((name) => {
            const active = filter === name
            const col = AGENT_COLORS[name] ?? '#aaa'
            return (
              <button
                key={name}
                type="button"
                onClick={() => setFilter(active ? null : name)}
                style={{
                  padding: '2px 8px',
                  fontSize: 10,
                  borderRadius: 10,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? col + '33' : 'transparent',
                  color: active ? col : '#666',
                }}
              >
                {name}
              </button>
            )
          })}
        </div>
      </div>
      <style>{`.ActivityPanel-scroll::-webkit-scrollbar { display: none } .ActivityPanel-scroll { -ms-overflow-style: none; scrollbar-width: none }`}</style>
      <div
        className="ActivityPanel-scroll"
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {visible.length === 0 && <div style={{ color: '#555', fontSize: 12 }}>—</div>}
        {visible.map((e) => (
          <div
            key={e.key}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              fontSize: 12,
              color: e.kind === 'action' && e.muted ? '#666' : '#e8e8e8',
              borderLeft: e.fromLLM ? `3px solid ${LLM_ENTRY_COLOR}` : undefined,
              paddingLeft: e.fromLLM ? 6 : 0,
              marginLeft: e.fromLLM ? 0 : 2,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: AGENT_COLORS[e.agentName] ?? '#888',
                flexShrink: 0,
                marginTop: 4,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ color: AGENT_COLORS[e.agentName] ?? '#888', fontWeight: 600 }}>
                {e.agentName}
                {e.agentRole ? ` (${e.agentRole})` : ''}
              </span>
              {e.fromLLM && (
                <span style={{ marginLeft: 6, fontSize: 9, color: LLM_ENTRY_COLOR, fontWeight: 500 }} title="From LLM/API call">LLM</span>
              )}
              {e.kind === 'say' && (
                <span style={{ marginLeft: 6, color: '#777', fontSize: 10 }}>{e.timeLabel}</span>
              )}
              {e.kind === 'action' ? (
                <span style={{ marginLeft: 6, color: e.muted ? '#666' : '#aaa' }}>{e.text}</span>
              ) : (
                <div style={{ marginTop: 2, color: '#ccc' }}>{e.text}</div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
