#!/usr/bin/env node
/**
 * Print dimensions of public/office-assets.png for tuning ITEM_SPRITE_REGIONS.
 * Run: node scripts/sprite-sheet-size.js
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const path = join(__dirname, '..', 'public', 'office-assets.png')
try {
  const buf = readFileSync(path)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    console.log('office-assets.png:', w, 'x', h)
  } else {
    console.log('Not a PNG or could not read dimensions')
  }
} catch (e) {
  console.error(e.message)
}
