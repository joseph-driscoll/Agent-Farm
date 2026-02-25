import { Container } from 'pixi.js'

export interface PixiLayers {
  root: Container
  background: Container
  items: Container
  agents: Container
  foreground: Container
  overlays: Container
}

export function createPixiLayers(): PixiLayers {
  const root = new Container()
  root.sortableChildren = true

  const background = new Container()
  background.zIndex = 0

  const items = new Container()
  items.zIndex = 10
  items.sortableChildren = true

  const agents = new Container()
  agents.zIndex = 20
  agents.sortableChildren = true

  const foreground = new Container()
  foreground.zIndex = 30
  foreground.sortableChildren = true

  const overlays = new Container()
  overlays.zIndex = 40

  root.addChild(background, items, agents, foreground, overlays)
  return { root, background, items, agents, foreground, overlays }
}

