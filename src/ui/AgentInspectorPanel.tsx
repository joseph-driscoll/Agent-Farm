import { useCallback, useState } from 'react'
import type { WorldState } from '../engine/schemas'
import { getDisplayNameForRole } from '../runtime/agentRoles'

interface AgentInspectorPanelProps {
  world: WorldState
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  /** When true, omit the title and intro line (e.g. when used inside a collapsible header). */
  hideTitle?: boolean
}

function inferFeeling(intent?: string): string {
  const v = (intent ?? '').trim()
  if (v === 'research') return 'Curious'
  if (v === 'propose') return 'Strategic'
  if (v === 'place_item') return 'Focused'
  if (v === 'sit_in_chair') return 'Settled'
  if (v === 'hold') return 'Idle'
  return 'Neutral'
}

export function AgentInspectorPanel({ world, selectedAgentId, onSelectAgent, hideTitle }: AgentInspectorPanelProps) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const selected = world.agents.find((a) => a.id === selectedAgentId) ?? null
  const chat = world.chatLog ?? []
  const events = world.lastEvents ?? []
  const proposals = world.artifacts.filter((a) => a.type === 'Proposal')
  const reports = world.artifacts.filter((a) => a.type === 'ResearchReport')

  const voteCountByAgent = new Map<string, number>()
  for (const votes of Object.values(world.artifactVotes ?? {})) {
    for (const agentId of Object.keys(votes)) {
      voteCountByAgent.set(agentId, (voteCountByAgent.get(agentId) ?? 0) + 1)
    }
  }

  const selectedStats =
    selected == null
      ? null
      : (() => {
          const sayCount = chat.filter((c) => c.agentId === selected.id && c.kind === 'say').length
          const thoughtCount = chat.filter((c) => c.agentId === selected.id && c.kind === 'thought').length
          const lastSay = [...chat].reverse().find((c) => c.agentId === selected.id && c.kind === 'say')?.text ?? '—'
          const placeCount = events.filter((e) => e.action.type === 'PLACE_ITEM' && e.action.agentId === selected.id).length
          const moveCount = events.filter((e) => e.action.type === 'MOVE_AGENT' && e.action.agentId === selected.id).length
          const setIntentCount = events.filter((e) => e.action.type === 'SET_INTENT' && e.action.agentId === selected.id).length
          const authoredProposals = proposals.filter((a) => a.authorAgentId === selected.id).length
          const authoredReports = reports.filter((a) => a.authorAgentId === selected.id).length
          const memoryCount = selected.memory?.length ?? 0
          const votesCast = voteCountByAgent.get(selected.id) ?? 0
          const contributionScore =
            authoredProposals * 8 +
            authoredReports * 10 +
            placeCount * 6 +
            votesCast * 2 +
            sayCount +
            memoryCount * 0.5
          return {
            sayCount,
            thoughtCount,
            lastSay,
            placeCount,
            moveCount,
            setIntentCount,
            authoredProposals,
            authoredReports,
            memoryCount,
            votesCast,
            contributionScore: Math.round(contributionScore),
          }
        })()

  const copyAgentStats = useCallback(() => {
    if (!selected || !selectedStats) return
    const lines: string[] = [
      '--- Agent Inspector (debug) ---',
      `Tick: ${world.tick}`,
      `Grid: ${world.gridWidth}x${world.gridHeight}`,
      `Scores: power=${world.scores.power.toFixed(0)} aesthetic=${world.scores.aesthetic.toFixed(0)} collaboration=${world.scores.collaboration.toFixed(0)} wastePenalty=${world.scores.wastePenalty.toFixed(0)}`,
      '',
      `Agent: ${selected.name} (${getDisplayNameForRole(selected.role)})`,
      `Id: ${selected.id}`,
      `Model: ${selected.model ?? 'default'}`,
      `Feeling: ${inferFeeling(selected.currentIntent)}`,
      `Intent: ${(selected.currentIntent ?? 'hold').replace(/_/g, ' ')}`,
      `Position: (${Math.floor(selected.x)}, ${Math.floor(selected.y)}) (0,0) top-left`,
      '',
      'Agent Score: ' + selectedStats.contributionScore,
      'Say: ' + selectedStats.sayCount,
      'Thought: ' + selectedStats.thoughtCount,
      'Moves: ' + selectedStats.moveCount,
      'Intent updates: ' + selectedStats.setIntentCount,
      'Place actions: ' + selectedStats.placeCount,
      'Votes cast: ' + selectedStats.votesCast,
      'Proposals authored: ' + selectedStats.authoredProposals,
      'Research reports authored: ' + selectedStats.authoredReports,
      'Memory entries: ' + selectedStats.memoryCount,
      '',
      'Last say: ' + selectedStats.lastSay,
    ]
    const text = lines.join('\n')
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyFeedback('Copied!')
        setTimeout(() => setCopyFeedback(null), 2000)
      },
      () => setCopyFeedback('Copy failed')
    )
  }, [selected, selectedStats, world.tick, world.gridWidth, world.gridHeight, world.scores])

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 320,
        flexShrink: 0,
        background: '#161625',
        border: '1px solid #2a2a3e',
        maxHeight: 700,
        overflow: 'hidden',
        padding: 16,
      }}
    >
      {!hideTitle && (
        <>
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#ccc' }}>Agent Inspector</h3>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#888' }}>
            Click an agent in the grid to inspect their simulation stats.
          </p>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Team Power</div>
          <div style={{ fontSize: 14, color: '#e5e7eb', fontWeight: 700 }}>{world.scores.power.toFixed(0)}</div>
        </div>
        <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Aesthetic</div>
          <div style={{ fontSize: 14, color: '#e5e7eb', fontWeight: 700 }}>{world.scores.aesthetic.toFixed(0)}</div>
        </div>
        <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Collaboration</div>
          <div style={{ fontSize: 14, color: '#e5e7eb', fontWeight: 700 }}>{world.scores.collaboration.toFixed(0)}</div>
        </div>
        <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Waste Penalty</div>
          <div style={{ fontSize: 14, color: '#fda4af', fontWeight: 700 }}>{world.scores.wastePenalty.toFixed(0)}</div>
        </div>
      </div>

      <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {world.agents.map((a) => {
          const isSelected = a.id === selectedAgentId
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelectAgent(a.id)}
              style={{
                textAlign: 'left',
                background: isSelected ? 'rgba(94,234,212,0.14)' : '#1a1a2a',
                border: isSelected ? '1px solid #5eead4' : '1px solid #2f2f46',
                color: '#d1d5db',
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {a.name} ({getDisplayNameForRole(a.role)}) · {(a.currentIntent ?? 'hold').replace(/_/g, ' ')}
            </button>
          )
        })}
      </div>

      {!selected || !selectedStats ? (
        <div style={{ fontSize: 12, color: '#94a3b8', border: '1px dashed #334155', borderRadius: 8, padding: 10 }}>
          No agent selected yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: '#cbd5e1' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <button
              type="button"
              onClick={copyAgentStats}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                background: '#2f2f46',
                border: '1px solid #5eead4',
                borderRadius: 6,
                color: '#5eead4',
                cursor: 'pointer',
              }}
              title="Copy all agent stats for debugging / pasting to support"
            >
              {copyFeedback ?? 'Copy stats'}
            </button>
            {copyFeedback && (
              <span style={{ fontSize: 11, color: '#86efac' }}>{copyFeedback}</span>
            )}
          </div>
          <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              {selected.name} ({getDisplayNameForRole(selected.role)})
            </div>
            <div>Model: {selected.model ?? 'default'}</div>
            <div>Feeling: {inferFeeling(selected.currentIntent)}</div>
            <div>Intent: {(selected.currentIntent ?? 'hold').replace(/_/g, ' ')}</div>
            <div>
              Position: ({Math.floor(selected.x)}, {Math.floor(selected.y)}) (0,0) top-left
            </div>
          </div>

          <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Agent Score</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#5eead4' }}>{selectedStats.contributionScore}</div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Composite contribution (dialogue + build + artifacts + votes)</div>
          </div>

          <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Simulation Metrics</div>
            <div>Say: {selectedStats.sayCount}</div>
            <div>Thought: {selectedStats.thoughtCount}</div>
            <div>Moves: {selectedStats.moveCount}</div>
            <div>Intent updates: {selectedStats.setIntentCount}</div>
            <div>Place actions: {selectedStats.placeCount}</div>
            <div>Votes cast: {selectedStats.votesCast}</div>
            <div>Proposals authored: {selectedStats.authoredProposals}</div>
            <div>Research reports authored: {selectedStats.authoredReports}</div>
            <div>Memory entries: {selectedStats.memoryCount}</div>
          </div>

          <div style={{ background: '#1d1d2d', border: '1px solid #2f2f46', borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Last Say</div>
            <div style={{ color: '#93c5fd' }}>{selectedStats.lastSay}</div>
          </div>
        </div>
      )}
    </div>
  )
}

