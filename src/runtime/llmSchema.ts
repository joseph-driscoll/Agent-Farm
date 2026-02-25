import { z } from 'zod'
import type { AgentTurn } from './llm'

const PlaceItemSchema = z.object({
  defId: z.string(),
  x: z.number(),
  y: z.number(),
  flipped: z.boolean().optional(),
})

const CreateArtifactSchema = z.object({
  artifactType: z.string(),
  title: z.string().optional(),
  payload: z.record(z.unknown()),
})

const VoteSchema = z.object({
  artifactId: z.string(),
  vote: z.enum(['yes', 'no']),
})

const AgentTurnSchema = z.object({
  say: z.string().optional(),
  thought: z.string().optional(),
  action: z.string().optional(),
  placeItem: PlaceItemSchema.optional().nullable(),
  createArtifact: CreateArtifactSchema.optional().nullable(),
  vote: VoteSchema.optional().nullable(),
  researchQuery: z.string().optional().nullable(),
  extractUrls: z.array(z.string()).optional().nullable(),
  crawl: z
    .object({
      url: z.string(),
      instructions: z.string().optional(),
    })
    .optional()
    .nullable(),
  remember: z
    .object({
      content: z.string(),
      importance: z.number().min(0).max(1).optional(),
    })
    .optional()
    .nullable(),
  loadSkill: z.string().optional().nullable(),
  createCharacter: z
    .object({
      description: z.string(),
      n_directions: z.number().int().min(4).max(8).optional(),
    })
    .optional()
    .nullable(),
  animateCharacter: z
    .object({
      characterId: z.string(),
      animation: z.string().optional(),
    })
    .optional()
    .nullable(),
  createTileset: z
    .object({
      lower: z.string(),
      upper: z.string(),
    })
    .optional()
    .nullable(),
  createIsometricTile: z
    .object({
      description: z.string(),
      size: z.number().int().min(16).max(64).optional(),
    })
    .optional()
    .nullable(),
})

function normalizeAction(rawAction: string | undefined): AgentTurn['action'] {
  if (rawAction == null) return 'hold'
  const a = rawAction.toLowerCase()
  if (a.includes('place_item')) return 'place_item'
  if (a.includes('expand')) return 'expand_room'
  if (a.includes('sit_in_chair') || (a.includes('sit') && a.includes('chair'))) return 'sit_in_chair'
  if (a.includes('research')) return 'research'
  if (a.includes('propose')) return 'propose'
  return 'hold'
}

export function parseAgentTurnResponse(raw: string): AgentTurn {
  const fallback: AgentTurn = { say: '', thought: '', action: 'hold' }
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').trim()
  const i = cleaned.indexOf('{')
  const j = cleaned.lastIndexOf('}') + 1
  if (i < 0 || j <= i) return fallback

  const parsedJson = JSON.parse(cleaned.slice(i, j)) as unknown
  const parsed = AgentTurnSchema.safeParse(parsedJson)
  if (!parsed.success) return fallback
  const turn = parsed.data

  return {
    say: (turn.say ?? '').trim().slice(0, 300),
    thought: '',
    action: normalizeAction(turn.action),
    placeItem: turn.placeItem
      ? {
          defId: String(turn.placeItem.defId),
          x: Math.round(Number(turn.placeItem.x)),
          y: Math.round(Number(turn.placeItem.y)),
          flipped: turn.placeItem.flipped,
        }
      : undefined,
    createArtifact: turn.createArtifact
      ? {
          artifactType: turn.createArtifact.artifactType,
          title: turn.createArtifact.title,
          payload: turn.createArtifact.payload,
        }
      : undefined,
    nextProposal: undefined,
    vote: turn.vote ?? undefined,
    researchQuery: turn.researchQuery?.slice(0, 200) ?? undefined,
    extractUrls: turn.extractUrls?.slice(0, 5) ?? undefined,
    crawl: turn.crawl
      ? {
          url: turn.crawl.url,
          instructions: turn.crawl.instructions ?? 'Summarize the main content and key points.',
        }
      : undefined,
    remember: turn.remember ?? undefined,
    loadSkill: turn.loadSkill ?? undefined,
    createCharacter: turn.createCharacter?.description
      ? {
          description: String(turn.createCharacter.description).trim().slice(0, 300),
          n_directions: turn.createCharacter.n_directions != null ? Math.min(8, Math.max(4, Math.round(Number(turn.createCharacter.n_directions)))) : undefined,
        }
      : undefined,
    animateCharacter: turn.animateCharacter?.characterId
      ? {
          characterId: String(turn.animateCharacter.characterId).trim(),
          animation: turn.animateCharacter.animation != null ? String(turn.animateCharacter.animation).trim() : undefined,
        }
      : undefined,
    createTileset: turn.createTileset?.lower != null && turn.createTileset?.upper != null
      ? {
          lower: String(turn.createTileset.lower).trim().slice(0, 100),
          upper: String(turn.createTileset.upper).trim().slice(0, 100),
        }
      : undefined,
    createIsometricTile: turn.createIsometricTile?.description
      ? {
          description: String(turn.createIsometricTile.description).trim().slice(0, 300),
          size: turn.createIsometricTile.size != null ? Math.min(64, Math.max(16, Math.round(Number(turn.createIsometricTile.size)))) : undefined,
        }
      : undefined,
  }
}

