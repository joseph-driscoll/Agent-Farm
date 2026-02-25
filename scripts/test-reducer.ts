import assert from 'node:assert/strict'
import { createInitialWorldState } from '../src/engine/worldState.js'
import { MAX_MEMORY_PER_AGENT, reduce } from '../src/engine/reducer.js'
import type { Action } from '../src/engine/schemas.js'

function apply(state: ReturnType<typeof createInitialWorldState>, action: Action, eventIndex: number) {
  return reduce(state, action, eventIndex).state
}

function main(): void {
  let world = createInitialWorldState()
  let eventIndex = 0

  // Architect creates a proposal.
  world = apply(
    world,
    {
      type: 'CREATE_ARTIFACT',
      agentId: 'agent-architect',
      artifactType: 'Proposal',
      payload: { defId: 'workstation', x: 10, y: 6 },
    },
    eventIndex++
  )
  assert.equal(world.artifacts.length, 1, 'proposal should be created')

  // Builder places proposal and reducer marks executed proposal id.
  world = apply(
    world,
    {
      type: 'PLACE_ITEM',
      agentId: 'agent-builder',
      defId: 'workstation',
      x: 10,
      y: 6,
    },
    eventIndex++
  )
  assert.equal(world.items.some((i) => i.defId === 'workstation' && i.x === 10 && i.y === 6), true, 'workstation should be placed')
  assert.equal((world.executedProposalIds ?? []).length, 1, 'executed proposal should be tracked')

  // Queue mismatch should fail placement.
  world = apply(
    world,
    {
      type: 'CREATE_ARTIFACT',
      agentId: 'agent-architect',
      artifactType: 'Proposal',
      payload: { defId: 'chair', x: 10, y: 7 },
    },
    eventIndex++
  )
  const before = world.items.length
  world = apply(
    world,
    {
      type: 'PLACE_ITEM',
      agentId: 'agent-builder',
      defId: 'chair',
      x: 8,
      y: 8,
    },
    eventIndex++
  )
  assert.equal(world.items.length, before, 'builder cannot place coordinates that do not match first queue proposal')

  // Memory-safety caps: long runs should remain bounded in reducer-managed arrays.
  for (let i = 0; i < 360; i++) {
    world = apply(
      world,
      {
        type: 'CREATE_ARTIFACT',
        agentId: 'agent-researcher',
        artifactType: 'ResearchReport',
        payload: { idx: i },
      },
      eventIndex++
    )
  }
  assert.ok(world.artifacts.length <= 300, `artifacts should be capped (got ${world.artifacts.length})`)

  for (let i = 0; i < 260; i++) {
    world = apply(
      world,
      { type: 'SAY', agentId: 'agent-builder', text: `line-${i}` },
      eventIndex++
    )
  }
  assert.ok((world.chatLog ?? []).length <= 200, `chat log should be capped (got ${(world.chatLog ?? []).length})`)
  assert.ok((world.lastEvents ?? []).length <= 200, `last events should be capped (got ${(world.lastEvents ?? []).length})`)

  for (let i = 0; i < 120; i++) {
    world = apply(
      world,
      {
        type: 'ADD_MEMORY',
        agentId: 'agent-builder',
        content: `memory-${i}`,
        importance: (i % 10) / 10,
      },
      eventIndex++
    )
  }
  const builder = world.agents.find((a) => a.id === 'agent-builder')
  assert.ok(builder, 'builder should exist')
  if (!builder) throw new Error('builder missing after setup')
  assert.equal(builder.memory?.length ?? 0, MAX_MEMORY_PER_AGENT, 'builder memory should be capped')

  // eslint-disable-next-line no-console
  console.log('test-reducer: ok')
}

main()

