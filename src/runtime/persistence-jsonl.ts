/**
 * EventLog persistence — append-only JSONL file.
 * Fallback when better-sqlite3 is not available (no native build).
 */
/// <reference types="node" />

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs'
import path from 'path'
import type { Action, Event } from '../engine/schemas.js'

let eventsPath: string = path.join(process.cwd(), 'agent-farm-events.jsonl')

export function openDb(filePath?: string): void {
  if (filePath) eventsPath = filePath
}

export function closeDb(): void {}

export function appendEvent(tick: number, eventIndex: number, action: Action): void {
  const line = JSON.stringify({ tick, eventIndex, action }) + '\n'
  appendFileSync(eventsPath, line, 'utf8')
}

export function loadAllEvents(): Event[] {
  if (!existsSync(eventsPath)) return []
  const content = readFileSync(eventsPath, 'utf8').trim()
  if (!content) return []
  return content.split('\n').map((line) => {
    const { tick, eventIndex, action } = JSON.parse(line) as { tick: number; eventIndex: number; action: Action }
    return { tick, eventIndex, action }
  })
}

/** Clear all events so next loadWorldState() returns fresh initial state. */
export function clearAllEvents(): void {
  writeFileSync(eventsPath, '', 'utf8')
}
