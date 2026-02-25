/**
 * Multi-agent graph: Researcher → Architect → Judge → Builder.
 * Stub order for tick; later can be LangGraph or conditional edges.
 */

import type { AgentRole } from '../engine/schemas.js'

export const AGENT_GRAPH_ORDER: AgentRole[] = [
  'Researcher',
  'Architect',
  'Judge',
  'Builder',
]

export function getAgentOrder(): AgentRole[] {
  return [...AGENT_GRAPH_ORDER]
}
