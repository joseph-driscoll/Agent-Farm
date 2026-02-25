// src/runtime/sendPos.ts
const lastSentAtByAgent = new Map<string, number>()

export function maybeSendAgentPos(ws: WebSocket | null, agentId: string, x: number, y: number): void {
  if (!ws || ws.readyState !== 1) return
  const now = performance.now()
  // throttle
  const lastSentAt = lastSentAtByAgent.get(agentId) ?? 0
  if (now - lastSentAt < 250) return
  lastSentAtByAgent.set(agentId, now)
  try {
    ws.send(JSON.stringify({ type: 'pos', agentId, x, y }))
  } catch {}
}

export function pruneSentPosCache(liveAgentIds: Iterable<string>): void {
  const live = new Set(liveAgentIds)
  for (const agentId of lastSentAtByAgent.keys()) {
    if (!live.has(agentId)) lastSentAtByAgent.delete(agentId)
  }
}

export function resetSentPosCache(): void {
  lastSentAtByAgent.clear()
}
