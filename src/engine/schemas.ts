/**
 * Shared Zod schemas — single source of truth for all structured data.
 * Agents emit Actions; reducer consumes them. No free-form text mutates world.
 */

import { z } from 'zod'

// —— Grid & cells ——
export const CellKind = z.enum(['empty', 'wall', 'floor', 'boundary'])
export type CellKind = z.infer<typeof CellKind>

export const CellSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  kind: CellKind,
  roomId: z.string().optional(),
  /** Floor paint/carpet color id (e.g. teal, mustard, carpet_teal). Rendered under items. */
  floorPaint: z.string().optional(),
  /** When true, this floor cell shows the main office floor slice at this tile (place-floor tool). */
  floorFromSlice: z.boolean().optional(),
  /** Wall paint color id (e.g. teal, mustard, soft_gray). */
  wallPaint: z.string().optional(),
})
export type Cell = z.infer<typeof CellSchema>

// —— Item definitions (data-driven) ——
export const ItemDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  footprint: z.tuple([z.number().int().positive(), z.number().int().positive()]), // [w, h]
  aestheticValue: z.number().min(0),
  powerValue: z.number().min(0),
  adjacencyPreferences: z.array(z.string()).optional(),
  unlockEffects: z.array(z.string()).optional(),
  requiresUnlock: z.string().optional(),
})
export type ItemDef = z.infer<typeof ItemDefSchema>

// —— Placed item instance ——
export const PlacedItemSchema = z.object({
  id: z.string(),
  defId: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  placedAtTick: z.number().int().min(0),
  /** When true, sprite is flipped (e.g. horizontal flip). Chairs face desks; computers face out. */
  flipped: z.boolean().optional(),
})
export type PlacedItem = z.infer<typeof PlacedItemSchema>

// —— Artifact types (collaboration) ——
export const ArtifactType = z.enum([
  'ResearchReport',
  'BuildSpec',
  'Proposal',
  'DecisionRecord',
  'StyleGuide',
  'PixelArt',
])
export type ArtifactType = z.infer<typeof ArtifactType>

export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactType,
  authorAgentId: z.string(),
  createdAtTick: z.number().int().min(0),
  title: z.string().optional(),
  payload: z.record(z.unknown()),
  refs: z.array(z.string()).optional(), // other artifact IDs
})
export type Artifact = z.infer<typeof ArtifactSchema>

// —— Agents ——
export const AgentRole = z.enum(['Researcher', 'Architect', 'Builder', 'Judge'])
export type AgentRole = z.infer<typeof AgentRole>

/** Episodic/semantic memory entry — state-of-the-art agent memory (importance + recency for retrieval). */
export const MemoryEntrySchema = z.object({
  /** Short factual content (event, observation, or distilled fact). */
  content: z.string(),
  /** Tick when this was stored (for recency). */
  tick: z.number().int().min(0),
  /** 0–1; higher = more important, kept longer when capping. */
  importance: z.number().min(0).max(1).optional(),
  /** 'episodic' = one-off event; 'semantic' = durable fact (optional for future merging). */
  kind: z.enum(['episodic', 'semantic']).optional(),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const AgentSchema = z.object({
  id: z.string(),
  role: AgentRole,
  name: z.string(),
  x: z.number(),
  y: z.number(),
  vx: z.number().optional(),
  vy: z.number().optional(),
  traits: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
  memory: z.array(MemoryEntrySchema).optional(),
  lastActionAtTick: z.number().int().optional(),
  currentIntent: z.string().optional(), // e.g. 'hold', 'sit_in_chair', 'research', 'propose', 'place_item'
  model: z.string().optional(), // OpenRouter model id for this agent's role
  personality: z.string().optional(), // short role/personality for prompts
  /** Skill ids this agent has loaded (full body injected into prompt). */
  loadedSkills: z.array(z.string()).optional(),
})
export type Agent = z.infer<typeof AgentSchema>

// —— Chat (say/thought) ——
export const ChatEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  text: z.string(),
  kind: z.enum(['say', 'thought']),
  tick: z.number().int().min(0),
  /** Timestamp (ms) when entry was added; used so UI can hide bubbles after TTL */
  at: z.number().optional(),
})
export type ChatEntry = z.infer<typeof ChatEntrySchema>

// —— Actions (only way to change world) ——
export const ActionType = z.enum([
  'PLACE_ITEM',
  'HUMAN_PLACE_ITEM', // Human places any asset manually (no proposal required)
  'HUMAN_PAINT_FLOOR_SLICE', // Human paints one floor cell with main office floor slice
  'HUMAN_REMOVE_ITEM', // Human removes an item at (x,y) from the UI
  'EXPAND_GRID',
  'CREATE_ARTIFACT',
  'ASK_AGENT',
  'RESPOND_AGENT',
  'REQUEST_REVIEW',
  'REVIEW_RESULT',
  'DELEGATE_TASK',
  'COMMENT_ARTIFACT',
  'VOTE',
  'LOAD_SKILL', // agent loads a skill by id (full body then injected into prompt)
  'FAIL_ACTION', // validation failure; logged, no state change
])
export type ActionType = z.infer<typeof ActionType>

export const PlaceItemActionSchema = z.object({
  type: z.literal('PLACE_ITEM'),
  agentId: z.string(),
  defId: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  /** Flip the placed item when necessary (chairs face desks, computers face out). */
  flipped: z.boolean().optional(),
})
export type PlaceItemAction = z.infer<typeof PlaceItemActionSchema>

/** Human places an asset manually from the UI — no proposal or agent required. */
export const HumanPlaceItemActionSchema = z.object({
  type: z.literal('HUMAN_PLACE_ITEM'),
  defId: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  flipped: z.boolean().optional(),
})
export type HumanPlaceItemAction = z.infer<typeof HumanPlaceItemActionSchema>

/** Human paints one floor cell with the main office floor slice (build menu "Place floor"). */
export const HumanPaintFloorSliceActionSchema = z.object({
  type: z.literal('HUMAN_PAINT_FLOOR_SLICE'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
})
export type HumanPaintFloorSliceAction = z.infer<typeof HumanPaintFloorSliceActionSchema>

/** Human removes one item that occupies cell (x, y) from the UI. Removes the topmost (last in list). */
export const HumanRemoveItemActionSchema = z.object({
  type: z.literal('HUMAN_REMOVE_ITEM'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
})
export type HumanRemoveItemAction = z.infer<typeof HumanRemoveItemActionSchema>

export const ExpandGridActionSchema = z.object({
  type: z.literal('EXPAND_GRID'),
  agentId: z.string(),
  direction: z.enum(['n', 's', 'e', 'w']),
  amount: z.number().int().positive().default(1),
})
export type ExpandGridAction = z.infer<typeof ExpandGridActionSchema>

export const CreateArtifactActionSchema = z.object({
  type: z.literal('CREATE_ARTIFACT'),
  agentId: z.string(),
  artifactType: ArtifactType,
  title: z.string().optional(),
  payload: z.record(z.unknown()),
  refs: z.array(z.string()).optional(),
})
export type CreateArtifactAction = z.infer<typeof CreateArtifactActionSchema>

export const CollaborationActionSchema = z.object({
  type: z.enum(['ASK_AGENT', 'RESPOND_AGENT', 'REQUEST_REVIEW', 'REVIEW_RESULT', 'DELEGATE_TASK', 'COMMENT_ARTIFACT']),
  agentId: z.string(),
  targetAgentId: z.string().optional(),
  artifactId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
})
export type CollaborationAction = z.infer<typeof CollaborationActionSchema>

export const MoveAgentActionSchema = z.object({
  type: z.literal('MOVE_AGENT'),
  agentId: z.string(),
  x: z.number(),
  y: z.number(),
})
export type MoveAgentAction = z.infer<typeof MoveAgentActionSchema>

export const SayActionSchema = z.object({
  type: z.literal('SAY'),
  agentId: z.string(),
  text: z.string(),
})
export type SayAction = z.infer<typeof SayActionSchema>

export const ThoughtActionSchema = z.object({
  type: z.literal('THOUGHT'),
  agentId: z.string(),
  text: z.string(),
})
export type ThoughtAction = z.infer<typeof ThoughtActionSchema>

export const SetIntentActionSchema = z.object({
  type: z.literal('SET_INTENT'),
  agentId: z.string(),
  intent: z.string(),
})
export type SetIntentAction = z.infer<typeof SetIntentActionSchema>

export const VoteActionSchema = z.object({
  type: z.literal('VOTE'),
  agentId: z.string(),
  artifactId: z.string(),
  vote: z.enum(['yes', 'no']),
})
export type VoteAction = z.infer<typeof VoteActionSchema>

export const FailActionSchema = z.object({
  type: z.literal('FAIL_ACTION'),
  agentId: z.string(),
  reason: z.string(),
  attemptedAction: z.record(z.unknown()),
})

export const AddMemoryActionSchema = z.object({
  type: z.literal('ADD_MEMORY'),
  agentId: z.string(),
  content: z.string(),
  importance: z.number().min(0).max(1).optional(),
  kind: z.enum(['episodic', 'semantic']).optional(),
})
export type AddMemoryAction = z.infer<typeof AddMemoryActionSchema>

export const LoadSkillActionSchema = z.object({
  type: z.literal('LOAD_SKILL'),
  agentId: z.string(),
  skillName: z.string(),
})
export type LoadSkillAction = z.infer<typeof LoadSkillActionSchema>

export const ActionSchema = z.union([
  PlaceItemActionSchema,
  HumanPlaceItemActionSchema,
  HumanPaintFloorSliceActionSchema,
  HumanRemoveItemActionSchema,
  ExpandGridActionSchema,
  CreateArtifactActionSchema,
  CollaborationActionSchema,
  MoveAgentActionSchema,
  SayActionSchema,
  ThoughtActionSchema,
  SetIntentActionSchema,
  VoteActionSchema,
  FailActionSchema,
  AddMemoryActionSchema,
  LoadSkillActionSchema,
])
export type Action = z.infer<typeof ActionSchema>

// —— Event log entry (append-only) ——
export const EventSchema = z.object({
  tick: z.number().int().min(0),
  eventIndex: z.number().int().min(0),
  action: ActionSchema,
  timestamp: z.number().int().positive().optional(),
})
export type Event = z.infer<typeof EventSchema>

// —— World state (single source of truth) ——
export const WorldStateSchema = z.object({
  tick: z.number().int().min(0),
  gridWidth: z.number().int().positive(),
  gridHeight: z.number().int().positive(),
  cells: z.array(CellSchema),
  items: z.array(PlacedItemSchema),
  itemDefs: z.array(ItemDefSchema),
  agents: z.array(AgentSchema),
  artifacts: z.array(ArtifactSchema),
  unlockedTech: z.array(z.string()),
  scores: z.object({
    power: z.number(),
    aesthetic: z.number(),
    collaboration: z.number(),
    wastePenalty: z.number(),
  }),
  lastEvents: z.array(EventSchema).optional(), // last N for observability
  chatLog: z.array(ChatEntrySchema).optional(), // recent say/thought, capped
  artifactVotes: z.record(z.string(), z.record(z.string(), z.enum(['yes', 'no']))).optional(), // artifactId -> agentId -> vote
  executedProposalIds: z.array(z.string()).optional(), // proposal artifact ids that have been built (so we don't place twice)
  rejectedProposalIds: z.array(z.string()).optional(), // proposal ids that failed placement (invalid position etc.) — skipped so queue advances
  /** Set by runtime on GET /world so UI can show whether LLM is active. */
  mode: z.enum(['llm', 'stub']).optional(),
  modeNote: z.string().optional(),
})
export type WorldState = z.infer<typeof WorldStateSchema>
