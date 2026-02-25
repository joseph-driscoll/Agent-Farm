/**
 * Lightweight skill loader: reads YAML-frontmatter + body from src/runtime/skills/*.yaml.
 * Exposes catalog (short descriptions for prompt) and full body for loaded skills only.
 * Used by LLM context builder — agents see catalog always; full skill body only when loaded.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(__dirname, 'skills')

export interface SkillMeta {
  id: string
  name: string
  description: string
  when: string
}

const KNOWN_SKILLS: SkillMeta[] = [
  { id: 'planner.discovery', name: 'Planner discovery', description: 'Project discovery / context gathering', when: 'planning, context gathering' },
  { id: 'planner.breakdown', name: 'Planner breakdown', description: 'Spec-driven breakdown into tasks and artifacts', when: 'breaking down goals' },
  { id: 'manager.routing', name: 'Manager routing', description: 'Turn plan into next tasks and assignments', when: 'routing work' },
  { id: 'worker.implementation', name: 'Worker implementation', description: 'Safe patch workflow and execution', when: 'executing tasks' },
]

function parseFrontmatter(content: string): { front: string; body: string } {
  const match = content.match(/^([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { front: content, body: '' }
  return { front: match[1].trim(), body: match[2].trim() }
}

/** Short catalog text injected into every agent prompt (cheap). */
export function getSkillCatalogText(): string {
  const lines = KNOWN_SKILLS.map((s) => `- ${s.id}: ${s.description} (when: ${s.when})`)
  return `Available skills (load with action LOAD_SKILL and skillName):\n${lines.join('\n')}`
}

/** Full body for one skill; empty if not found or not on disk. */
export function getSkillBody(skillId: string): string {
  const filePath = join(SKILLS_DIR, `${skillId}.yaml`)
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath, 'utf8')
    const { body } = parseFrontmatter(raw)
    return body
  } catch {
    return ''
  }
}

/** Format loaded skill bodies for prompt injection (only those in loadedIds). */
export function formatLoadedSkills(loadedIds: string[]): string {
  if (!loadedIds.length) return ''
  const blocks: string[] = []
  for (const id of loadedIds) {
    const body = getSkillBody(id)
    if (body) blocks.push(`--- Skill: ${id} ---\n${body}\n---`)
  }
  return blocks.length ? `\n${blocks.join('\n')}\n` : ''
}
