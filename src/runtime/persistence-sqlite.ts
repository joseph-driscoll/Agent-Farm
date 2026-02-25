/**
 * EventLog persistence — SQLite via better-sqlite3 (real backend).
 * Use when native deps install (Node LTS or Python + Build Tools on Windows).
 */
/// <reference types="node" />

import { createRequire } from 'module'
import path from 'path'
import type { Action, Event } from '../engine/schemas.js'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: InstanceType<typeof Database> | null = null
let dbPath: string = path.join(process.cwd(), 'agent-farm.db')

export function openDb(filePath?: string): void {
  if (db) return
  if (filePath) dbPath = filePath
  db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      tick INTEGER NOT NULL,
      event_index INTEGER NOT NULL,
      action_json TEXT NOT NULL,
      created_at INTEGER,
      PRIMARY KEY (tick, event_index)
    );
    CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick);
  `)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function appendEvent(tick: number, eventIndex: number, action: Action): void {
  if (!db) throw new Error('openDb() must be called first')
  db.prepare(
    'INSERT INTO events (tick, event_index, action_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(tick, eventIndex, JSON.stringify(action), Math.floor(Date.now() / 1000))
}

export function loadAllEvents(): Event[] {
  if (!db) throw new Error('openDb() must be called first')
  const rows = db.prepare('SELECT tick, event_index, action_json FROM events ORDER BY tick, event_index').all() as Array<{ tick: number; event_index: number; action_json: string }>
  return rows.map((r) => ({
    tick: r.tick,
    eventIndex: r.event_index,
    action: JSON.parse(r.action_json) as Action,
  }))
}

/** Clear all events so next loadWorldState() returns fresh initial state. */
export function clearAllEvents(): void {
  if (!db) throw new Error('openDb() must be called first')
  db.prepare('DELETE FROM events').run()
}
