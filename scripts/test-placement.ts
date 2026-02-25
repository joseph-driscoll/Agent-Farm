import assert from 'node:assert/strict'
import {
  BACK_WALL_ROWS,
  BUILD_START_ROW,
  canPlaceAt,
  createInitialWorldState,
} from '../src/engine/worldState.js'

function main(): void {
  const world = createInitialWorldState()

  assert.equal(canPlaceAt(world, 'workstation', 10, BUILD_START_ROW), true, 'workstation should place at build start row')
  assert.equal(canPlaceAt(world, 'workstation', 10, BUILD_START_ROW - 1), false, 'workstation should not place in buffer rows')
  assert.equal(canPlaceAt(world, 'table_small', 2, BACK_WALL_ROWS), true, 'table_small should place on floor buffer row')
  assert.equal(canPlaceAt(world, 'table_small', 2, BACK_WALL_ROWS - 1), true, 'table_small should place on back-wall counter row')
  assert.equal(canPlaceAt(world, 'coffee_maker', 2, BACK_WALL_ROWS - 1), false, 'coffee maker needs an existing table')
  assert.equal(canPlaceAt(world, 'coffee_left', 2, BACK_WALL_ROWS), false, 'coffee cup should not place on floor')
  assert.equal(canPlaceAt(world, 'printer', 2, BACK_WALL_ROWS), false, 'printer should not place on floor')

  const withTable = createInitialWorldState({
    items: [
      {
        id: 'tb-1',
        defId: 'table_small',
        x: 2,
        y: BACK_WALL_ROWS,
        placedAtTick: 0,
      },
    ],
  })
  assert.equal(canPlaceAt(withTable, 'coffee_left', 2, BACK_WALL_ROWS), true, 'coffee cup should place on table')
  assert.equal(canPlaceAt(withTable, 'printer', 2, BACK_WALL_ROWS), true, 'printer should place on table')

  const withDesk = createInitialWorldState({
    items: [
      {
        id: 'ws-1',
        defId: 'workstation',
        x: 10,
        y: BUILD_START_ROW,
        placedAtTick: 0,
      },
    ],
  })

  assert.equal(canPlaceAt(withDesk, 'chair', 10, BUILD_START_ROW + 1), true, 'chair should place on left desk slot')
  assert.equal(canPlaceAt(withDesk, 'chair', 11, BUILD_START_ROW + 1), false, 'chair should reject non-slot desk cell')
  assert.equal(canPlaceAt(withDesk, 'computer', 11, BUILD_START_ROW + 1), false, 'computer requires chair first')

  const withChair = createInitialWorldState({
    items: [
      {
        id: 'ws-1',
        defId: 'workstation',
        x: 10,
        y: BUILD_START_ROW,
        placedAtTick: 0,
      },
      {
        id: 'ch-1',
        defId: 'chair',
        x: 10,
        y: BUILD_START_ROW + 1,
        placedAtTick: 0,
      },
    ],
  })
  assert.equal(canPlaceAt(withChair, 'computer', 11, BUILD_START_ROW + 1), true, 'computer should place after left chair')
  assert.equal(canPlaceAt(withChair, 'computer', 13, BUILD_START_ROW + 1), false, 'computer should reject right side without right chair')
  const withComputer = createInitialWorldState({
    items: [
      {
        id: 'ws-1',
        defId: 'workstation',
        x: 10,
        y: BUILD_START_ROW,
        placedAtTick: 0,
      },
      {
        id: 'ch-1',
        defId: 'chair',
        x: 10,
        y: BUILD_START_ROW + 1,
        placedAtTick: 0,
      },
      {
        id: 'pc-1',
        defId: 'computer',
        x: 11,
        y: BUILD_START_ROW + 1,
        placedAtTick: 0,
      },
    ],
  })
  assert.equal(
    canPlaceAt(withComputer, 'wall_top', 11, BUILD_START_ROW + 2),
    true,
    'computer should not occupy the tile below its base cell'
  )

  const withWatercooler = createInitialWorldState({
    items: [
      {
        id: 'wc-1',
        defId: 'watercooler',
        x: 4,
        y: BACK_WALL_ROWS - 1,
        placedAtTick: 0,
      },
    ],
  })
  assert.equal(
    canPlaceAt(withWatercooler, 'wall_top', 4, BACK_WALL_ROWS),
    true,
    'watercooler should not occupy the tile below its base cell'
  )

  const withPlant = createInitialWorldState({
    items: [
      {
        id: 'pl-1',
        defId: 'plant',
        x: 6,
        y: BACK_WALL_ROWS - 1,
        placedAtTick: 0,
      },
    ],
  })
  assert.equal(
    canPlaceAt(withPlant, 'wall_top', 6, BACK_WALL_ROWS),
    true,
    'plant should not occupy the tile below its base cell'
  )
  assert.equal(canPlaceAt(world, 'plant', 8, BACK_WALL_ROWS), false, 'plant should require adjacency to amenity')
  assert.equal(canPlaceAt(withTable, 'plant', 4, BACK_WALL_ROWS), true, 'plant should place next to table as accent')
  assert.equal(canPlaceAt(world, 'couch', 8, BACK_WALL_ROWS + 5), false, 'couch should not place in open middle floor')

  const noAgents = createInitialWorldState({ agents: [] })
  assert.equal(
    canPlaceAt(noAgents, 'wall_top', 2, 7),
    true,
    'spawn coordinates should not be permanently reserved for placement'
  )

  // Perimeter walls must leave at least one doorway gap of 2+ cells on west/east/south.
  const perimeterItems: Array<{ id: string; defId: string; x: number; y: number; placedAtTick: number }> = []
  let seq = 0
  const pushWall = (x: number, y: number) => {
    perimeterItems.push({ id: `w-${seq++}`, defId: 'wall_top', x, y, placedAtTick: 0 })
  }
  const gridWidth = world.gridWidth
  const gridHeight = world.gridHeight
  // Fully wall west + east.
  for (let y = BACK_WALL_ROWS; y < gridHeight; y++) {
    pushWall(0, y)
    pushWall(gridWidth - 1, y)
  }
  // Wall south except a 2-cell doorway at x=10,11.
  for (let x = 0; x < gridWidth; x++) {
    if (x === 10 || x === 11) continue
    pushWall(x, gridHeight - 1)
  }
  const withPerimeterDoor = createInitialWorldState({ items: perimeterItems })
  assert.equal(canPlaceAt(withPerimeterDoor, 'wall_top', 10, gridHeight - 1), false, 'cannot close doorway down to 1-cell gap')
  assert.equal(canPlaceAt(withPerimeterDoor, 'wall_top', 10, BACK_WALL_ROWS - 1), true, 'back-wall wall_top should remain placeable')

  // eslint-disable-next-line no-console
  console.log('test-placement: ok')
}

main()

