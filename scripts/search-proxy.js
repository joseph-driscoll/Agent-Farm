#!/usr/bin/env node
/**
 * Search proxy for Agent Farm. Uses @tavily/core when TAVILY_API_KEY is set.
 * Run: pnpm run search-proxy. In .env: VITE_SEARCH_API_URL=http://localhost:3010
 */

import http from 'http'
import https from 'https'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tavily } from '@tavily/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '..', '.env')
if (existsSync(envPath)) {
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

const PORT = Number(process.env.SEARCH_PROXY_PORT || process.env.PORT) || 3010
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim()
const SERPER_API_KEY = (process.env.SERPER_API_KEY || '').trim()
const USE_TAVILY = TAVILY_API_KEY.length > 0
const tvly = USE_TAVILY ? tavily({ apiKey: TAVILY_API_KEY }) : null

if (!USE_TAVILY && !SERPER_API_KEY) {
  console.error('Set TAVILY_API_KEY (https://app.tavily.com) or SERPER_API_KEY')
  process.exit(1)
}

function serve(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const q = url.searchParams.get('q') || ''
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'GET' || !q) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Use GET /?q=...', results: [] }))
    return
  }
  if (USE_TAVILY) {
    tvly
      .search(q, { searchDepth: 'basic', maxResults: 6, topic: 'general' })
      .then((response) => {
        const raw = response.results || []
        const results = raw.slice(0, 6).map((r) => ({
          title: r.title || '',
          snippet: (r.content || '').slice(0, 300) + ((r.content || '').length > 300 ? '…' : ''),
          url: r.url || '',
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results }))
      })
      .catch((e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e?.message || 'Tavily error', results: [] }))
      })
  } else {
    const body = JSON.stringify({ q })
    const options = {
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const proxyReq = https.request(options, (proxyRes) => {
      let data = ''
      proxyRes.on('data', (ch) => { data += ch })
      proxyRes.on('end', () => {
        try {
          const json = JSON.parse(data)
          const organic = json.organic || []
          const results = organic.slice(0, 6).map((r) => ({
            title: r.title || '',
            snippet: (r.snippet || '').slice(0, 300) + ((r.snippet || '').length > 300 ? '…' : ''),
            url: r.link || '',
          }))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results }))
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid response from Serper', results: [] }))
        }
      })
    })
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message, results: [] }))
    })
    proxyReq.write(body)
    proxyReq.end()
  }
}

const server = http.createServer(serve)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[search] http://localhost:${PORT}/?q=... (${USE_TAVILY ? 'Tavily' : 'Serper'})`)
})
