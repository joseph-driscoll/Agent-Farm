import assert from 'node:assert/strict'
import { pickRoundRobinIndexAvoidRepeat } from '../src/runtime/schedulerPolicy.js'
import type { Agent } from '../src/engine/schemas.js'

const agents: Agent[] = [
  { id: 'a1', role: 'Researcher', name: 'Nova', x: 1, y: 1 },
  { id: 'a2', role: 'Architect', name: 'Sage', x: 2, y: 2 },
  { id: 'a3', role: 'Builder', name: 'Pixel', x: 3, y: 3 },
]

function main(): void {
  const i0 = pickRoundRobinIndexAvoidRepeat(agents, 0, null)
  assert.equal(i0, 0, 'no previous speaker should keep preferred index')

  const i1 = pickRoundRobinIndexAvoidRepeat(agents, 0, 'a1')
  assert.equal(i1, 1, 'should skip repeated speaker when alternatives exist')

  const i2 = pickRoundRobinIndexAvoidRepeat(agents, 2, 'a3')
  assert.equal(i2, 0, 'should wrap and pick next non-repeating agent')

  // eslint-disable-next-line no-console
  console.log('test-scheduler: ok')
}

main()

