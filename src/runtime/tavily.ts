/**
 * Tavily client for the Researcher agent: search + research (when API key set).
 * With TAVILY_API_KEY: uses @tavily/core directly (search, research).
 * Without: uses VITE_SEARCH_API_URL / SEARCH_API_URL proxy for search only.
 *
 * Usage (from @tavily/core):
 *   const { tavily } = require("@tavily/core");
 *   const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
 *   const response = await tvly.research("Your query");  // returns { requestId, status, ... }
 *   // Full content comes from tvly.getResearch(response.requestId) — we poll until status === 'complete'.
 */
/// <reference types="node" />

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

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

const TAVILY_API_KEY = (process.env.TAVILY_API_KEY ?? '').trim()
const SEARCH_API_URL = (process.env.VITE_SEARCH_API_URL || process.env.SEARCH_API_URL || '').trim()

export interface SearchResult {
  title: string
  snippet: string
  url: string
}

/** Whether the SDK is available (API key set); enables research() and direct search. */
export function hasTavilySdk(): boolean {
  return TAVILY_API_KEY.length > 0
}

type TavilyClient = {
  search: (q: string, opts?: object) => Promise<{ results?: Array<{ title?: string; content?: string; url?: string }> }>
  research: (q: string, opts?: object) => Promise<{ requestId: string }>
  getResearch: (id: string) => Promise<{ status: string; content?: string; sources?: Array<{ title: string; url: string }> }>
  extract: (urls: string[], opts?: object) => Promise<{ results: Array<{ url: string; title: string | null; rawContent: string }>; failedResults: Array<{ url: string; error: string }> }>
  crawl: (url: string, opts?: { instructions?: string; limit?: number; timeout?: number }) => Promise<{ baseUrl?: string; results: Array<{ url: string; rawContent: string }> }>
}
let _client: TavilyClient | null = null
async function getClient(): Promise<TavilyClient | null> {
  if (!TAVILY_API_KEY) return null
  if (!_client) {
    const { tavily } = (await import('@tavily/core')) as { tavily: (opts: { apiKey: string }) => TavilyClient }
    _client = tavily({ apiKey: TAVILY_API_KEY })
  }
  return _client
}

/** Search: SDK when API key set, else proxy. Returns results for snapshot/Reports. */
export async function search(query: string): Promise<SearchResult[]> {
  const client = await getClient()
  if (client) {
    try {
      const response = await (client.search(query, {
        searchDepth: 'basic',
        maxResults: 8,
        topic: 'general',
        timeout: 12_000,
      }) as Promise<{ results?: Array<{ title?: string; content?: string; url?: string }> }>)
      const raw = response.results ?? []
      return raw.slice(0, 8).map((r) => ({
        title: r.title ?? '',
        snippet: (r.content ?? '').slice(0, 200),
        url: r.url ?? '',
      }))
    } catch {
      return []
    }
  }
  if (!SEARCH_API_URL) return []
  const url = `${SEARCH_API_URL.replace(/\/$/, '')}/?q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const data = (await res.json()) as { results?: SearchResult[] }
    return data.results ?? []
  } catch {
    return []
  }
}

export interface ResearchResult {
  summary: string
  sources: Array<{ title: string; url: string }>
  requestId?: string
}

/** Deep research on a topic (SDK only). Polls getResearch until complete or timeout. */
export async function research(query: string, options?: { model?: 'mini' | 'pro'; timeoutMs?: number }): Promise<ResearchResult | null> {
  const client = await getClient()
  if (!client) return null
  const timeoutMs = options?.timeoutMs ?? 45_000
  const model = options?.model ?? 'mini'
  try {
    const created = await (client.research(query, { model, stream: false }) as Promise<{ requestId: string }>)
    const requestId = created?.requestId
    if (!requestId) return null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await (client.getResearch(requestId) as Promise<
        { status: string; content?: string; sources?: Array<{ title: string; url: string }> }
      >)
      if (result.status === 'complete' && result.content != null) {
        const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        return {
          summary: content.slice(0, 4000),
          sources: result.sources ?? [],
          requestId,
        }
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    return null
  } catch {
    return null
  }
}

export interface ExtractResult {
  summary: string
  byUrl: Array<{ url: string; title: string | null; snippet: string }>
  failed: Array<{ url: string; error: string }>
}

/** Extract raw content from up to 5 URLs (SDK only). Feeds into snapshot or ResearchReport. */
export async function extract(urls: string[], options?: { timeout?: number }): Promise<ExtractResult | null> {
  const client = await getClient()
  if (!client || !urls.length) return null
  const list = urls.slice(0, 5).filter((u) => typeof u === 'string' && u.startsWith('http'))
  if (!list.length) return null
  try {
    const response = await (client.extract(list, {
      format: 'text',
      timeout: options?.timeout ?? 15_000,
    }) as Promise<{ results: Array<{ url: string; title: string | null; rawContent: string }>; failedResults: Array<{ url: string; error: string }> }>)
    const byUrl = (response.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? null,
      snippet: (r.rawContent ?? '').slice(0, 800),
    }))
    const summary = byUrl.map((r) => `${r.title || r.url}: ${r.snippet.slice(0, 400)}`).join('\n\n')
    return {
      summary: summary.slice(0, 4000),
      byUrl,
      failed: response.failedResults ?? [],
    }
  } catch {
    return null
  }
}

export interface CrawlResult {
  summary: string
  baseUrl: string
  pages: Array<{ url: string; snippet: string }>
}

/** Crawl a site with natural-language instructions (SDK only). Goal-directed gathering. */
export async function crawl(
  url: string,
  options?: { instructions?: string; limit?: number; timeout?: number }
): Promise<CrawlResult | null> {
  const client = await getClient()
  if (!client || !url.startsWith('http')) return null
  try {
    const response = await (client.crawl(url, {
      instructions: options?.instructions ?? 'Summarize the main content and key points.',
      limit: Math.min(options?.limit ?? 5, 10),
      timeout: options?.timeout ?? 20_000,
    }) as Promise<{ baseUrl: string; results: Array<{ url: string; rawContent: string }> }>)
    const pages = (response.results ?? []).slice(0, 8).map((r) => ({
      url: r.url,
      snippet: (r.rawContent ?? '').slice(0, 600),
    }))
    const summary = pages.map((p) => `${p.url}: ${p.snippet}`).join('\n\n')
    return {
      summary: summary.slice(0, 4000),
      baseUrl: response.baseUrl ?? url,
      pages,
    }
  } catch {
    return null
  }
}
