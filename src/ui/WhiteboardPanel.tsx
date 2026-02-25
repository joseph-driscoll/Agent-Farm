/**
 * Right panel — Build / turn rate is automatic (one turn per LLM response).
 */

import type { WorldState } from '../engine/schemas'

interface WhiteboardPanelProps {
  world?: WorldState | null
}

export function WhiteboardPanel({}: WhiteboardPanelProps) {
  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        background: '#161625',
        borderRadius: 12,
        border: '1px solid #2a2a3e',
        maxHeight: 700,
        overflow: 'hidden',
        padding: 16,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#ccc' }}>Build</h3>
      <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
        Turn rate is automatic: one agent turn per LLM response. Who goes next is chosen by the scheduler (Builder when
        there’s something to place, Architect when the queue is empty or a proposal is due, otherwise round-robin).
      </p>
    </div>
  )
}
