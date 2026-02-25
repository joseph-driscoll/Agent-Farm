/**
 * EventLog persistence — real backend when possible, JSONL fallback otherwise.
 * Uses better-sqlite3 if available (set AGENT_FARM_USE_SQLITE=1 and have it installed);
 * otherwise append-only JSONL. Same API, deterministic replay.
 */
/// <reference types="node" />

import { createRequire } from 'module'
import { createInitialWorldState } from '../engine/worldState.js'
import { reduce, advanceTick } from '../engine/reducer.js'
import { updateScoresFromWorld } from '../engine/scoring.js'
import type { WorldState, Action, Event } from '../engine/schemas.js'
import * as jsonl from './persistence-jsonl.js'

const require = createRequire(import.meta.url)
const USE_SQLITE = process.env.AGENT_FARM_USE_SQLITE === '1' || process.env.AGENT_FARM_USE_SQLITE === 'true'
let backend: typeof jsonl | null = null
const MAX_REPLAY_EVENTS = Math.max(1_000, Number(process.env.AGENT_FARM_MAX_REPLAY_EVENTS) || 60_000)

function getBackend(): typeof jsonl {
  if (backend) return backend
  if (USE_SQLITE) {
    try {
      backend = require('./persistence-sqlite.js') as typeof jsonl
      return backend
    } catch {
      backend = jsonl
      return backend
    }
  }
  backend = jsonl
  return backend
}

export function openDb(filePath?: string): void {
  getBackend().openDb(filePath)
}

export function closeDb(): void {
  if (backend) backend.closeDb()
}

export function appendEvent(tick: number, eventIndex: number, action: Action): void {
  getBackend().appendEvent(tick, eventIndex, action)
}

export function loadAllEvents(): Event[] {
  return getBackend().loadAllEvents()
}

export function replayToState(events: Event[]): WorldState {
  let state = createInitialWorldState()
  let currentTick = -1
  let eventIndexInTick = 0
  for (const ev of events) {
    if (ev.tick > currentTick) {
      while (state.tick < ev.tick) {
        state = advanceTick(state)
      }
      currentTick = ev.tick
      eventIndexInTick = 0
    }
    const { state: next } = reduce(state, ev.action, eventIndexInTick++)
    state = next
  }
  return updateScoresFromWorld(state)
}

export function loadWorldState(): WorldState {
  const allEvents = loadAllEvents()
  const events = allEvents.length > MAX_REPLAY_EVENTS ? allEvents.slice(-MAX_REPLAY_EVENTS) : allEvents
  return replayToState(events)
}

/** Clear persisted events and allow a full reset (nuke). */
export function clearAllEvents(): void {
  getBackend().clearAllEvents()
}
