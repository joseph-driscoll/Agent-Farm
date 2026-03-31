import type { WorldState } from '../engine/schemas'
import { getDisplayNameForRole, getModelForRole } from '../runtime/agentRoles'
import type { AgentRole } from '../engine/schemas'

/** Match agent-sandbox AgentChatPanel / side panel */
const AGENT_COLORS: Record<string, string> = {
  Nova: '#ff6b6b',
  Sage: '#4ecdc4',
  Pixel: '#ffe66d',
}

interface TruthPanelProps {
  world: WorldState
}

export function TruthPanel({ world }: TruthPanelProps) {
  const events = world.lastEvents ?? []
  const lastFew = events.slice(-14).reverse()

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        background: '#161625',
        borderLeft: '1px solid #2a2a3e',
        display: 'flex',
        flexDirection: 'column',
        height: 'fit-content',
        maxHeight: 'calc(100vh - 180px)',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #2a2a3e',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e8e8e8' }}>Truth Panel</h2>
        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#888' }}>Tick · Scores · Agents · Events</p>
      </div>
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <section>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Tick</h3>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 600, color: '#e8e8e8' }}>{world.tick}</p>
        </section>
        <section>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Scores</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#e8e8e8', lineHeight: 1.6 }}>
            <li>Power: <strong>{world.scores.power.toFixed(1)}</strong></li>
            <li>Aesthetic: <strong>{world.scores.aesthetic.toFixed(1)}</strong></li>
            <li>Collaboration: <strong>{world.scores.collaboration.toFixed(1)}</strong></li>
            <li>Waste: <strong style={{ color: '#ff6b6b' }}>{world.scores.wastePenalty}</strong></li>
          </ul>
        </section>
        <section>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Agents</h3>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {world.agents.map((a) => (
              <li
                key={a.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 6,
                  fontSize: 13,
                  color: '#e8e8e8',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: AGENT_COLORS[a.name] ?? '#888',
                    flexShrink: 0,
                  }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  <span><strong>{a.name}</strong> ({getDisplayNameForRole(a.role)})</span>
                  <span style={{ color: '#666', fontSize: 10, fontWeight: 400 }}>{a.model ?? getModelForRole(a.role as AgentRole)}</span>
                </span>
                <span style={{ color: '#555', fontSize: 11 }}>@{Math.floor(a.x)},{Math.floor(a.y)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Activity</h3>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 11, maxHeight: 160, overflow: 'auto' }}>
            {(world.chatLog ?? []).filter((e) => e.kind === 'say').slice(-16).reverse().map((e) => (
              <li key={e.id} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #2a2a3e' }}>
                <span style={{ color: AGENT_COLORS[e.agentName] ?? '#888', fontWeight: 600 }}>{e.agentName}</span>
                <div style={{ color: '#e8e8e8', marginTop: 2 }}>{e.text.slice(0, 100)}{e.text.length > 100 ? '…' : ''}</div>
              </li>
            ))}
            {(world.chatLog ?? []).filter((e) => e.kind === 'say').length === 0 && <li style={{ color: '#555' }}>—</li>}
          </ul>
        </section>
        <section>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Items &amp; Artifacts</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#e8e8e8' }}>
            {world.items.length} items · {world.artifacts.length} artifacts
            {(world.artifacts ?? []).some((a) => a.type === 'PixelArt') && (
              <span style={{ color: '#9ca3af' }}>
                {' '}
                (PixelArt: {(world.artifacts ?? []).filter((a) => a.type === 'PixelArt').length})
              </span>
            )}
          </p>
        </section>
        <section style={{ flex: 1, minHeight: 0 }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Last actions</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#888', lineHeight: 1.5, maxHeight: 220, overflow: 'auto' }}>
            {lastFew.length === 0 && <li>—</li>}
            {lastFew.map((ev, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <span style={{ color: '#555' }}>t{ev.tick}</span> {ev.action.type}
                {'agentId' in ev.action && (
                  <span style={{ color: '#666' }}> · {(ev.action as { agentId: string }).agentId.slice(0, 12)}…</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
