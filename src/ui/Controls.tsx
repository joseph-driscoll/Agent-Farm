/**
 * Top bar — Grid toggle, Copy logs, Nuke (full reset).
 */

import { useState } from 'react'

interface ControlsProps {
  showGrid?: boolean
  onToggleGrid?: () => void
  showCellCoordinates?: boolean
  onToggleCellCoordinates?: () => void
  /** When true, LLM is on; when false, stub mode (no credits). */
  llmEnabled?: boolean
  onToggleLlm?: () => void
}

export function Controls({ showGrid = true, onToggleGrid, showCellCoordinates = false, onToggleCellCoordinates, llmEnabled = true, onToggleLlm }: ControlsProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'ok' | 'err'>('idle')

  const handleLlmToggle = async () => {
    if (onToggleLlm == null) return
    try {
      const r = await fetch('/api/llm-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !llmEnabled }),
      })
      if (r.ok) onToggleLlm()
    } catch (e) {
      console.error('LLM toggle failed', e)
    }
  }

  const handleNuke = async () => {
    try {
      const r = await fetch('/api/nuke', { method: 'POST' })
      if (r.ok) window.location.reload()
      else console.error('Nuke failed', r.status)
    } catch (e) {
      console.error('Nuke failed', e)
    }
  }

  const handleCopyLogs = async () => {
    setCopyStatus('idle')
    try {
      const r = await fetch('/api/logs')
      if (!r.ok) throw new Error(r.statusText)
      const text = await r.text()
      await navigator.clipboard.writeText(text)
      setCopyStatus('ok')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch (e) {
      setCopyStatus('err')
      setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {onToggleGrid != null && (
        <button
          type="button"
          onClick={onToggleGrid}
          title={showGrid ? 'Hide grid' : 'Show grid'}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            borderRadius: 8,
            border: '1px solid #4a4a6a',
            background: showGrid ? 'rgba(180, 140, 255, 0.2)' : 'transparent',
            color: showGrid ? '#c4b5fd' : '#888',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Grid {showGrid ? 'on' : 'off'}
        </button>
      )}
      {onToggleCellCoordinates != null && (
        <button
          type="button"
          onClick={onToggleCellCoordinates}
          title={showCellCoordinates ? 'Hide cell coordinates' : 'Show cell coordinates (0,0) top-left'}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            borderRadius: 8,
            border: '1px solid #4a4a6a',
            background: showCellCoordinates ? 'rgba(180, 140, 255, 0.2)' : 'transparent',
            color: showCellCoordinates ? '#c4b5fd' : '#888',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Coords {showCellCoordinates ? 'on' : 'off'}
        </button>
      )}
      {onToggleLlm != null && (
        <button
          type="button"
          onClick={handleLlmToggle}
          title={llmEnabled ? 'Turn off LLM (stub mode — no API credits)' : 'Turn on LLM'}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            borderRadius: 8,
            border: '1px solid #4a4a6a',
            background: llmEnabled ? 'rgba(78, 205, 196, 0.2)' : 'rgba(248, 113, 113, 0.15)',
            color: llmEnabled ? '#5eead4' : '#fca5a5',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          LLM {llmEnabled ? 'on' : 'off'}
        </button>
      )}
      <button
        type="button"
        onClick={handleCopyLogs}
        title="Copy runtime logs (chronological) for pasting into chat for debugging"
        style={{
          padding: '6px 12px',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid #4a4a6a',
          background: 'transparent',
          color: copyStatus === 'ok' ? '#86efac' : copyStatus === 'err' ? '#f87171' : '#94a3b8',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        {copyStatus === 'ok' ? 'Copied' : copyStatus === 'err' ? 'Copy failed' : 'Copy logs'}
      </button>
      <button
        type="button"
        onClick={handleNuke}
        style={{
          padding: '6px 12px',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid #b91c1c',
          background: 'transparent',
          color: '#f87171',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        Nuke
      </button>
      <span style={{ fontSize: 13, color: '#888' }}>3 agents</span>
    </div>
  )
}
