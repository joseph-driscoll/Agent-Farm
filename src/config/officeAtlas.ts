/**
 * Agent role → base frame name for workstation_atlas.json.
 * Actual sprite regions come from workstation_atlas (agent_*_body, agent_*_hair).
 */

/** Map world role -> base frame name (spriteRegistry appends _body / _hair). */
export const ROLE_TO_AGENT_FRAME: Record<string, string> = {
  Researcher: 'agent_analyst',
  Architect: 'agent_architect',
  Builder: 'agent_builder',
  Judge: 'agent_analyst',
}
