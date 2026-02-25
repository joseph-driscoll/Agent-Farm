/**
 * Tool for the human to place any asset manually on the grid.
 * Select an asset from the list, then click a cell on the grid to place.
 * Use the "Delete Item" button in the nav to remove objects.
 */

import { useState, useMemo } from 'react'
import type { ItemDef } from '../engine/schemas'
import { getCanonicalItemDefs } from '../engine/worldState'

interface PlaceItemToolProps {
  selectedDefId: string | null
  onSelectDef: (defId: string | null) => void
  onClose: () => void
}

export function PlaceItemTool({ selectedDefId, onSelectDef, onClose }: PlaceItemToolProps) {
  const [search, setSearch] = useState('')
  const itemDefs = getCanonicalItemDefs() as ItemDef[]
  const filteredDefs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return itemDefs
    return itemDefs.filter(
      (d) =>
        (d.name ?? d.id).toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q)
    )
  }, [itemDefs, search])
  const selectedDef = selectedDefId ? itemDefs.find((d) => d.id === selectedDefId) : null

  return (
    <div
      className="PlaceItemTool-scroll"
      style={{
        width: '100%',
        maxWidth: 320,
        flex: 1,
        minHeight: 0,
        background: '#161625',
        borderRadius: 12,
        border: '1px solid #2a2a3e',
        overflow: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <style>{`.PlaceItemTool-scroll::-webkit-scrollbar { display: none } .PlaceItemTool-scroll { -ms-overflow-style: none; scrollbar-width: none }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#ccc' }}>Place item (manual)</h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: '1px solid #475569',
            color: '#94a3b8',
            padding: '4px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Close
        </button>
      </div>

      <p style={{ margin: '0 0 10px 0', fontSize: 12, color: '#666' }}>
        {selectedDefId
          ? `Selected: ${selectedDef?.name ?? selectedDefId}. Click a cell on the grid to place.`
          : 'Choose an asset, then click on the grid to place it.'}
      </p>
      <input
        type="search"
        placeholder="Search assets..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: '100%',
          marginBottom: 10,
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid #334155',
          background: '#1e293b',
          color: '#e2e8f0',
          fontSize: 13,
        }}
        aria-label="Filter placeable assets"
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 6,
          width: '100%',
        }}
      >
        {filteredDefs.length === 0 ? (
          <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12, color: '#64748b' }}>
            No assets match "{search.trim()}"
          </p>
        ) : (
        filteredDefs.map((def) => (
          <button
            key={def.id}
            type="button"
            onClick={() => onSelectDef(selectedDefId === def.id ? null : def.id)}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: selectedDefId === def.id ? '2px solid #4ecdc4' : '1px solid #334155',
              background: selectedDefId === def.id ? 'rgba(78, 205, 196, 0.15)' : '#1e293b',
              color: '#e2e8f0',
              cursor: 'pointer',
              fontSize: 13,
              textAlign: 'left',
            }}
            title={`${def.name} (${def.footprint[0]}×${def.footprint[1]})`}
          >
            <span style={{ fontWeight: 600 }}>{def.name}</span>
            <span style={{ display: 'block', fontSize: 11, color: '#64748b', marginTop: 2 }}>
              {def.footprint[0]}×{def.footprint[1]}
            </span>
          </button>
        ))
        )}
      </div>
      {selectedDefId && (
        <button
          type="button"
          onClick={() => onSelectDef(null)}
          style={{
            marginTop: 16,
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #475569',
            background: 'transparent',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Clear selection
        </button>
      )}
    </div>
  )
}
