import { Rectangle, Sprite, Texture } from 'pixi.js'
import type { SpriteEntry } from '../../config/spriteRegistry'

const textureCache = new Map<string, Texture>()
const frameTextureCache = new Map<string, Texture>()

function getBaseTexture(sheetUrl: string): Texture {
  const existing = textureCache.get(sheetUrl)
  if (existing) return existing
  const created = Texture.from(sheetUrl)
  // Pixel-art sheet must use nearest sampling or thin/top slices blur when scaled.
  created.source.scaleMode = 'nearest'
  textureCache.set(sheetUrl, created)
  return created
}

function frameKey(entry: SpriteEntry): string {
  const r = entry.region
  return `${entry.sheetUrl}:${r.x},${r.y},${r.w},${r.h}`
}

function getFrameTexture(entry: SpriteEntry): Texture {
  const key = frameKey(entry)
  const existing = frameTextureCache.get(key)
  if (existing) return existing
  const base = getBaseTexture(entry.sheetUrl)
  const frame = new Rectangle(entry.region.x, entry.region.y, entry.region.w, entry.region.h)
  const created = new Texture({ source: base.source, frame })
  frameTextureCache.set(key, created)
  return created
}

export function createSpriteFromEntry(entry: SpriteEntry, width: number, height: number): Sprite {
  const texture = getFrameTexture(entry)
  if (!texture || !texture.source) {
    const fallback = new Sprite(Texture.EMPTY)
    fallback.width = width
    fallback.height = height
    return fallback
  }
  const sprite = new Sprite(texture)
  sprite.width = width
  sprite.height = height
  sprite.roundPixels = true
  return sprite
}

export function __clearSpriteTextureCachesForTests(): void {
  frameTextureCache.clear()
  textureCache.clear()
}

export function __getSpriteTextureCacheStatsForTests(): { baseTextures: number; frameTextures: number } {
  return {
    baseTextures: textureCache.size,
    frameTextures: frameTextureCache.size,
  }
}

