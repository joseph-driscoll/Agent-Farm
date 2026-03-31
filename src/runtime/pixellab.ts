/**
 * PixelLab MCP client for the Architect/Builder agents: pixel art generation
 * (characters, tilesets, isometric tiles, animations).
 * Uses MCP over HTTP: https://api.pixellab.ai/mcp with Bearer token.
 * When PIXELLAB_API_TOKEN is missing, all functions return null (no-op).
 */
/// <reference types="node" />

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../logger.js'

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  try {
    const env = readFileSync(envPath, 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch (_) {}
}

loadEnv()

const PIXELLAB_API_TOKEN = (process.env.PIXELLAB_API_TOKEN ?? process.env.PIXELLAB_API_KEY ?? '').trim()
const MCP_URL = 'https://api.pixellab.ai/mcp'
const DEFAULT_TIMEOUT_MS = 45_000

export function hasPixellab(): boolean {
  return PIXELLAB_API_TOKEN.length > 0
}

export interface PixellabCharacterResult {
  characterId?: string
  urls?: string[]
  error?: string
}

export interface PixellabTilesetResult {
  tilesetId?: string
  urls?: string[]
  error?: string
}

export interface PixellabTileResult {
  tileId?: string
  url?: string
  error?: string
}

export interface PixellabAnimationResult {
  animationId?: string
  urls?: string[]
  error?: string
}

let _requestId = 0
function nextId(): number {
  _requestId += 1
  return _requestId
}

async function mcpCall<T = unknown>(method: string, params: Record<string, unknown>): Promise<{ result?: T; error?: string }> {
  if (!PIXELLAB_API_TOKEN) {
    return { error: 'No PIXELLAB_API_TOKEN set' }
  }
  const id = nextId()
  const body = { jsonrpc: '2.0', id, method, params }
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PIXELLAB_API_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const raw = await res.text()
    if (!res.ok) {
      log('AGENT', 'PixelLab HTTP error', { status: res.status, body: raw.slice(0, 200) })
      return { error: `HTTP ${res.status}: ${raw.slice(0, 100)}` }
    }
    let data: { result?: T; error?: { code?: number; message?: string } }
    try {
      data = JSON.parse(raw) as { result?: T; error?: { code?: number; message?: string } }
    } catch {
      return { error: 'Invalid JSON response' }
    }
    if (data.error) {
      const msg = data.error.message ?? String(data.error.code ?? 'Unknown error')
      log('AGENT', 'PixelLab MCP error', { method, message: msg })
      return { error: msg }
    }
    return { result: data.result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('AGENT', 'PixelLab request failed', { method, error: msg })
    return { error: msg }
  }
}

function extractUrlsFromContent(content: unknown): string[] {
  const urls: string[] = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object') {
        const o = item as { type?: string; url?: string; text?: string }
        if (o.url && typeof o.url === 'string') urls.push(o.url)
        if (o.type === 'image' && o.url) urls.push(o.url)
        if (o.text && typeof o.text === 'string') {
          const m = o.text.match(/https?:\/\/[^\s"]+/g)
          if (m) urls.push(...m)
        }
      }
    }
  }
  return urls
}

function extractTextFromContent(content: unknown): string {
  if (Array.isArray(content)) {
    const parts = content
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
      .map((item) => (item as { text?: string }).text)
      .filter((t): t is string => typeof t === 'string')
    return parts.join(' ').trim()
  }
  return ''
}

/** Create a pixel art character. Returns characterId/urls or error. */
export async function createCharacter(
  description: string,
  n_directions: number = 8
): Promise<PixellabCharacterResult | null> {
  if (!hasPixellab()) return null
  const { result, error } = await mcpCall<{ content?: unknown }>('tools/call', {
    name: 'create_character',
    arguments: { description: description.trim().slice(0, 500), n_directions },
  })
  if (error) return { error }
  if (!result) return null
  const content = (result as { content?: unknown }).content
  const urls = extractUrlsFromContent(content)
  const text = extractTextFromContent(content)
  const characterId = text && /[a-f0-9-]{20,}/i.test(text) ? text.match(/[a-f0-9-]{20,}/i)?.[0] : undefined
  return { characterId: characterId ?? undefined, urls: urls.length ? urls : undefined }
}

/** Animate an existing character (walk, run, idle, etc.). */
export async function animateCharacter(
  characterId: string,
  animation: string = 'walk'
): Promise<PixellabAnimationResult | null> {
  if (!hasPixellab()) return null
  const { result, error } = await mcpCall<{ content?: unknown }>('tools/call', {
    name: 'animate_character',
    arguments: { character_id: characterId.trim(), animation: animation.trim().slice(0, 50) || 'walk' },
  })
  if (error) return { error }
  if (!result) return null
  const content = (result as { content?: unknown }).content
  const urls = extractUrlsFromContent(content)
  return { animationId: characterId, urls: urls.length ? urls : undefined }
}

/** Create a Wang tileset (lower/upper theme). */
export async function createTileset(lower: string, upper: string): Promise<PixellabTilesetResult | null> {
  if (!hasPixellab()) return null
  const { result, error } = await mcpCall<{ content?: unknown }>('tools/call', {
    name: 'create_tileset',
    arguments: { lower: lower.trim().slice(0, 100), upper: upper.trim().slice(0, 100) },
  })
  if (error) return { error }
  if (!result) return null
  const content = (result as { content?: unknown }).content
  const urls = extractUrlsFromContent(content)
  return { tilesetId: undefined, urls: urls.length ? urls : undefined }
}

/** Create a single isometric tile. */
export async function createIsometricTile(
  description: string,
  size: number = 32
): Promise<PixellabTileResult | null> {
  if (!hasPixellab()) return null
  const { result, error } = await mcpCall<{ content?: unknown }>('tools/call', {
    name: 'create_isometric_tile',
    arguments: { description: description.trim().slice(0, 500), size: Math.min(64, Math.max(16, size)) },
  })
  if (error) return { error }
  if (!result) return null
  const content = (result as { content?: unknown }).content
  const urls = extractUrlsFromContent(content)
  return { url: urls[0], tileId: undefined }
}
