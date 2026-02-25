/**
 * Central logging for agent-farm: one-line, timestamped, categorized.
 * Use for debugging: copy console output or GET /api/logs in chronological order.
 */

export type LogCategory =
  | 'TICK'
  | 'AGENT'
  | 'SCHEDULER'
  | 'REDUCER'
  | 'LLM'
  | 'MOVEMENT'
  | 'SIM'
  | 'PERSISTENCE'
  | 'HTTP'
  | 'ERROR'
  | 'WARN'
  | 'STATE'

const MAX_BUFFER_LINES = 2000
const buffer: string[] = []
let bufferIndex = 0

function ts(): string {
  return new Date().toISOString()
}

function pushLine(line: string): void {
  const entry = line
  if (buffer.length < MAX_BUFFER_LINES) {
    buffer.push(entry)
  } else {
    buffer[bufferIndex % MAX_BUFFER_LINES] = entry
  }
  bufferIndex++
}

/**
 * Log one line: [timestamp] [CATEGORY] message (optional JSON on same line).
 * Safe to call from anywhere; order is preserved for copy-paste.
 */
export function log(
  category: LogCategory,
  message: string,
  data?: Record<string, unknown> | unknown
): void {
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : ''
  const line = `[${ts()}] [${category}] ${message}${dataStr}`
  pushLine(line)
  if (category === 'ERROR') {
    console.error(line)
  } else if (category === 'WARN') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

/**
 * Return the last N log lines in chronological order, suitable for pasting into chat.
 * Use from runtime (e.g. GET /api/logs) or in dev console: copy(require('./logger').getLogDump())
 */
export function getLogDump(maxLines: number = 1500): string {
  if (buffer.length < MAX_BUFFER_LINES) {
    return buffer.join('\n')
  }
  const start = bufferIndex % MAX_BUFFER_LINES
  const ordered: string[] = []
  for (let i = 0; i < MAX_BUFFER_LINES; i++) {
    const idx = (start + i) % MAX_BUFFER_LINES
    ordered.push(buffer[idx]!)
  }
  const tail = ordered.slice(-maxLines)
  return tail.join('\n')
}

/**
 * Clear in-memory buffer (e.g. after nuke or when starting a fresh debug session).
 */
export function clearLogBuffer(): void {
  buffer.length = 0
  bufferIndex = 0
}
