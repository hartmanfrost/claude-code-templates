/**
 * jev-model-router — pure decision logic.
 *
 * No `$` and no I/O here: this module validates the options, builds the
 * request the decision API takes, reads its answer, and turns that answer
 * into a subagent's model and effort. The hooks module does every call on
 * `$`.
 *
 * Two backends speak to the same model with different wire shapes:
 *
 *   typesafe  POST https://api.typesafe.ai/v1/systemone
 *             `{ model, state, questions }`; a yes/no question is a `noul`
 *             and every answer carries its own `confidence`.
 *   gateway   POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
 *             `{ state, questions }` with the model in a header; a yes/no
 *             question is a `boolean`, and there is no `confidence` field —
 *             it has to be derived from an optional distribution.
 *
 * The Gateway shape is not documented publicly; it was read from
 * @ai-sdk/gateway and @ai-sdk/provider.
 */

import { DEFAULT_REDACT, compileCustomPatterns, mergeCounts, prepareField } from './redact.ts'
import type { RedactCounts, RedactOptions } from './redact.ts'

export type Provider = 'typesafe' | 'gateway'

/** The only models the router ever picks. Never anything else. */
export type Family = 'haiku' | 'sonnet' | 'opus'

export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus']

export type Tier = 'fast' | 'balanced' | 'deep'

export interface Tiers {
  fast: Family
  balanced: Family
  deep: Family
}

export interface Decision {
  tier: Tier
  /** Confidence in the tier, or null when the backend reported none. */
  confidence: number | null
  /** P(true) that carrying the task out would itself be costly or final. */
  risky: number | null
  /** 0..3 along the effort rubric, or null when absent. */
  effort: number | null
  /** Confidence in the effort, or null when the backend reported none. */
  effortConfidence: number | null
}

/** The reasoning levels a turn can ask for, cheapest first. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

export type Effort = (typeof EFFORT_ORDER)[number]

export const TIER_ORDER: readonly Tier[] = ['fast', 'balanced', 'deep']

/**
 * How each tier is described to the decision model. Deliberately about the
 * shape of the work, not about model names: the model never sees an id.
 */
const TIER_CRITERIA: Record<Tier, string> = {
  fast: 'Mechanical and local: read or summarise a file, run one command, rename a symbol, answer something already in context.',
  balanced:
    'Ordinary engineering: implement a well-specified change across a few files, write tests, fix a clearly described bug, review a small diff.',
  deep: 'Hard or high-stakes: architecture and design, debugging a failure whose cause is unknown, security, data migrations, concurrency, anything touching production or money.',
}

const EFFORT_RUBRIC = ['almost none', 'some', 'a lot', 'as much as possible'] as const

export const DEFAULT_BASE_URL: Record<Provider, string> = {
  typesafe: 'https://api.typesafe.ai',
  gateway: 'https://ai-gateway.vercel.sh/v4/ai',
}

/**
 * The Gateway's own protocol version, sent as `ai-gateway-protocol-version`.
 * Tracks the `AI_GATEWAY_PROTOCOL_VERSION` of `@ai-sdk/gateway` (4.0.87).
 */
const AI_GATEWAY_PROTOCOL_VERSION = '0.0.1'

export const DEFAULT_MODEL: Record<Provider, string> = {
  typesafe: 'jev-latest',
  gateway: 'typesafe-ai/jev',
}

/**
 * Which backend a configuration asks for, or null for the built-in
 * classifier. `auto` prefers TypeSafe, since it is the only one that reports
 * a calibrated confidence; a forced backend whose key is missing resolves to
 * null rather than falling through to the other one's key.
 */
export function selectProvider(
  forced: string,
  typesafeKey: string,
  gatewayKey: string,
): Provider | null {
  if (forced === 'builtin') return null
  if (forced === 'typesafe') return typesafeKey ? 'typesafe' : null
  if (forced === 'gateway') return gatewayKey ? 'gateway' : null
  if (typesafeKey) return 'typesafe'
  if (gatewayKey) return 'gateway'
  return null
}

/** The full endpoint a backend posts to. */
export function endpoint(provider: Provider, baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return provider === 'typesafe' ? `${root}/v1/systemone` : `${root}/evaluation-model`
}

/** The `questions` map, in the shape the backend's schema names. */
export function questions(provider: Provider): Record<string, unknown> {
  return {
    tier: {
      type: 'choice',
      instructions: 'Which is the cheapest tier that can complete this coding task well?',
      criteria: TIER_CRITERIA,
    },
    effort: {
      type: 'score',
      instructions: 'How much step-by-step reasoning does this task need?',
      criteria: EFFORT_RUBRIC,
    },
    risky: {
      // The same question under two names: `noul` on TypeSafe's own API,
      // `boolean` in the AI SDK's evaluation schema.
      type: provider === 'typesafe' ? 'noul' : 'boolean',
      // Asked about the act, not the subject. The first wording ("the task
      // touches production, money, credentials") scored 0.96 on "add a
      // refund endpoint that calls Stripe" — ordinary code that happens to be
      // about money — and would have escalated it past a 0.98-confidence
      // answer of the balanced tier.
      instructions:
        'Carrying out this task would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.',
    },
  }
}

/** The request body. The Gateway carries the model in a header instead. */
export function requestBody(
  provider: Provider,
  state: Record<string, unknown>,
  model: string,
): string {
  const body =
    provider === 'typesafe'
      ? { model, state, questions: questions(provider) }
      : { state, questions: questions(provider) }
  return JSON.stringify(body)
}

/** The request headers. */
export function requestHeaders(
  provider: Provider,
  apiKey: string,
  model: string,
): Record<string, string> {
  const common = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  if (provider === 'typesafe') return common
  return {
    ...common,
    'ai-gateway-auth-method': 'api-key',
    'ai-model-id': model,
    // The Gateway rejects any request that does not name the protocol it
    // speaks: 400 "Unsupported gateway protocol version". Every other header
    // here is accepted without it, so the omission fails the whole backend.
    'ai-gateway-protocol-version': AI_GATEWAY_PROTOCOL_VERSION,
    'ai-evaluation-model-specification-version': '4',
  }
}

export function isTier(value: unknown): value is Tier {
  return value === 'fast' || value === 'balanced' || value === 'deep'
}

/**
 * Reads a response from either backend.
 *
 * TypeSafe's own API reports a `confidence` per answer and a `noul` number
 * for a yes/no question. The Gateway reports neither: confidence has to come
 * from the highest probability of a distribution that is itself optional, and
 * a yes/no answer arrives as `probability`. Both are handled, and a missing
 * confidence reads as null rather than as a number the policy would trust.
 */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> }).answers
  if (typeof answers !== 'object' || answers === null) return null

  const tierAnswer = answers.tier
  if (!tierAnswer || !isTier(tierAnswer.choice)) return null

  const effortAnswer = answers.effort
  const riskyAnswer = answers.risky
  const risky = unit(riskyAnswer?.noul) ?? unit(riskyAnswer?.probability)
  const score = effortAnswer?.score

  return {
    tier: tierAnswer.choice,
    confidence: confidenceOf(tierAnswer),
    effort: typeof score === 'number' && Number.isFinite(score) ? Math.min(3, Math.max(0, score)) : null,
    effortConfidence: effortAnswer ? confidenceOf(effortAnswer) : null,
    risky,
  }
}

/** A probability: a finite number in 0..1, anything else reads as absent. */
function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

/**
 * How sure an answer is. TypeSafe reports it; the Gateway does not, so there
 * it is the highest probability of a distribution that is itself optional.
 */
function confidenceOf(answer: Record<string, unknown>): number | null {
  const reported = unit(answer.confidence)
  if (reported !== null) return reported
  const probabilities = answer.probabilities
  if (typeof probabilities !== 'object' || probabilities === null) return null
  const values = Object.values(probabilities as Record<string, unknown>)
    .map(unit)
    .filter((v): v is number => v !== null)
  return values.length > 0 ? Math.max(...values) : null
}

/** The rubric score (0..3) as a reasoning level. */
export function effortLevel(score: number): Effort {
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, Math.round(score)))
  return EFFORT_ORDER[index] as Effort
}

/**
 * Where a reasoning level sits on the ladder, or null when its place cannot
 * be known. `max` is above every rung the rubric can produce, so it ranks
 * above them without joining EFFORT_ORDER, which is also the set of values
 * this router is allowed to ask for.
 */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== 'string') return null
  if (effort === 'max') return EFFORT_ORDER.length
  const index = EFFORT_ORDER.indexOf(effort as Effort)
  return index === -1 ? null : index
}


// ---- models --------------------------------------------------------------

/**
 * Where a model sits on the ladder, by the family word in its name; null for
 * anything else. The router only ever picks the three families, and never
 * touches a model it cannot place (`fable`, a custom id): comparing ranks is
 * what makes `claude-opus-5-5[1m]` and `opus` the same tier.
 */
export function rankOf(model: string): number | null {
  const lowered = model.toLowerCase()
  if (lowered.includes('fable')) return null
  if (lowered.includes('haiku')) return 0
  if (lowered.includes('sonnet')) return 1
  if (lowered.includes('opus')) return 2
  return null
}

/** An option value as a family alias, or null (also for anything `fable`). */
export function parseFamily(value: unknown): Family | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return (FAMILIES as readonly string[]).includes(v) ? (v as Family) : null
}

/**
 * The full id a family alias names on the main loop.
 *
 * `agent.spawn` takes an alias (`haiku`) the way the Agent tool does, but
 * `turn.step`'s `model` is the id the engine already resolved for the request
 * and goes to the API as written: an alias there is refused. So the tiers stay
 * aliases in the options, and only a main-loop rewrite resolves them, here.
 * The ids are the ones Claude Code 2.1.305 reported for these aliases.
 */
const ALIAS_IDS: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/** What to write into `turn.step`'s `model`: the id behind a family alias. */
export function requestModelId(model: string): string {
  return ALIAS_IDS[model.trim().toLowerCase()] ?? model
}

// ---- options -------------------------------------------------------------

export interface PolicyConfig {
  tiers: Tiers
  /**
   * How sure the decision must be to spend more than the fallback (a bigger
   * model, more reasoning). Being wrong here costs money, so the bar is low.
   */
  minUpgradeConfidence: number
  /**
   * How sure it must be to spend less than the fallback. Being wrong means a
   * task handled by too small a model or too little thought, so the bar is high.
   */
  minDowngradeConfidence: number
  /** What a subagent runs on when there is no usable decision. */
  fallbackModel: Family
  fallbackEffort: Effort
}

/** `keyless`: no key for the chosen backend; subagents get the fallback. */
export type Mode = 'jev' | 'builtin' | 'keyless'

export interface RouterConfig {
  mode: Mode
  /** The provider the key belongs to, or null. */
  provider: Provider | null
  /** The `provider` option as given (`auto` by default). */
  forced: string
  apiKey: string
  modelId: string
  url: string
  policy: PolicyConfig
  routeSubagentModel: boolean
  routeSubagentEffort: boolean
  routeMainEffort: boolean
  routeMainModel: boolean
  routeMainLoop: boolean
  timeoutMs: number
  logDecisions: boolean
  statusFile: boolean
  maxPromptChars: number
  redactSensitive: boolean
  redact: RedactOptions
}

/** Why a base URL may not receive the key, or null when it may. */
export function validateBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'not a valid URL'
  }
  if (url.username || url.password) return 'must not contain credentials'
  if (url.protocol === 'https:') return null
  const host = url.hostname
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
  if (url.protocol === 'http:' && loopback) return null
  return 'must be https (plain http only for localhost)'
}

type RawOptions = Record<string, unknown>

/**
 * Reads and validates the plugin's options. A value that is the wrong type,
 * out of range or not an allowed choice falls back to its default and is
 * reported in `warnings` (the caller shows them), never silently.
 */
export function resolveOptions(options: RawOptions): { config: RouterConfig; warnings: string[] } {
  const warnings: string[] = []
  const given = (key: string) => options[key] !== undefined && options[key] !== ''

  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string).trim() : fallback

  const flag = (key: string, fallback: boolean) => {
    const v = options[key]
    if (typeof v === 'boolean') return v
    if (given(key)) warnings.push(`${key}: expected true or false, using ${fallback}`)
    return fallback
  }

  const ranged = (key: string, fallback: number, min: number, max: number) => {
    const v = options[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v
    if (given(key)) warnings.push(`${key}: expected a number from ${min} to ${max}, using ${fallback}`)
    return fallback
  }

  const family = (key: string, fallback: Family): Family => {
    if (!given(key)) return fallback
    const parsed = parseFamily(options[key])
    if (parsed) return parsed
    warnings.push(`${key}: only haiku, sonnet or opus are allowed, using ${fallback}`)
    return fallback
  }

  const effort = (key: string, fallback: Effort): Effort => {
    if (!given(key)) return fallback
    const v = typeof options[key] === 'string' ? (options[key] as string).trim().toLowerCase() : ''
    if ((EFFORT_ORDER as readonly string[]).includes(v)) return v as Effort
    warnings.push(`${key}: only low, medium, high or xhigh are allowed, using ${fallback}`)
    return fallback
  }

  const typesafeKey = text('typesafeApiKey', '')
  const gatewayKey = text('gatewayApiKey', '')
  let forced = text('provider', 'auto')
  if (!['auto', 'typesafe', 'gateway', 'builtin'].includes(forced)) {
    warnings.push(`provider: "${forced}" is not auto, typesafe, gateway or builtin, using auto`)
    forced = 'auto'
  }
  const provider = selectProvider(forced, typesafeKey, gatewayKey)
  const mode: Mode = forced === 'builtin' ? 'builtin' : provider ? 'jev' : 'keyless'

  const baseUrl = (key: string, fallback: string) => {
    const raw = text(key, '')
    if (!raw) return fallback
    const problem = validateBaseUrl(raw)
    if (problem) {
      warnings.push(`${key}: ${problem}, using ${fallback}`)
      return fallback
    }
    return raw
  }

  const url = !provider
    ? ''
    : provider === 'typesafe'
      ? endpoint('typesafe', baseUrl('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe))
      : endpoint('gateway', baseUrl('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))
  const modelId = !provider
    ? ''
    : provider === 'typesafe'
      ? text('typesafeModel', DEFAULT_MODEL.typesafe)
      : text('gatewayModel', DEFAULT_MODEL.gateway)

  const custom = compileCustomPatterns(options.redactPatterns)
  warnings.push(...custom.errors)

  const redactSensitive = flag('redactSensitive', true)
  const routeMainEffort = flag('routeMainEffort', false)
  const routeMainModel = flag('routeMainModel', false)

  const config: RouterConfig = {
    mode,
    provider,
    forced,
    apiKey: provider === 'typesafe' ? typesafeKey : provider === 'gateway' ? gatewayKey : '',
    modelId,
    url,
    policy: {
      tiers: {
        fast: family('fastModel', 'haiku'),
        balanced: family('balancedModel', 'sonnet'),
        deep: family('deepModel', 'opus'),
      },
      minUpgradeConfidence: ranged('minUpgradeConfidence', 0.3, 0, 1),
      minDowngradeConfidence: ranged('minDowngradeConfidence', 0.6, 0, 1),
      fallbackModel: family('fallbackModel', 'opus'),
      fallbackEffort: effort('fallbackEffort', 'medium'),
    },
    routeSubagentModel: flag('routeSubagentModel', true),
    routeSubagentEffort: flag('routeSubagentEffort', true),
    routeMainEffort,
    routeMainModel,
    routeMainLoop: routeMainEffort || routeMainModel,
    timeoutMs: ranged('timeoutMs', 1500, 100, 30000),
    logDecisions: flag('logDecisions', true),
    statusFile: flag('statusFile', true),
    maxPromptChars: ranged('maxPromptChars', 4000, 200, 20000),
    redactSensitive,
    redact: {
      ...DEFAULT_REDACT,
      enabled: redactSensitive,
      emails: flag('redactEmails', false),
      ips: flag('redactIps', false),
      homePaths: flag('redactHomePaths', false),
      custom: custom.patterns,
    },
  }
  return { config, warnings }
}

// ---- deciding ------------------------------------------------------------

const RISKY_BAR = 0.7

export interface Routing {
  /** The model to run on, or null to leave the request as it is. */
  model: string | null
  /** The reasoning level to ask for, or null to leave it as it is. */
  effort: Effort | null
  /** Why, for the log line. */
  reason: string
}

const NOTHING: Routing = { model: null, effort: null, reason: 'no decision' }

/**
 * Whether a change of rank passes its threshold. Both directions are allowed;
 * they just do not have to clear the same bar, because the two mistakes do not
 * cost the same. A move whose direction cannot be told (an unrecognised
 * current value) is treated as an upgrade.
 */
function allowed(
  wanted: number,
  current: number | null,
  confidence: number | null,
  config: PolicyConfig,
): boolean {
  if (current !== null && wanted === current) return false
  const isDowngrade = current !== null && wanted < current
  const bar = isDowngrade ? config.minDowngradeConfidence : config.minUpgradeConfidence
  // A backend that reports no confidence (the Gateway without a distribution,
  // or the built-in classifier) clears the upgrade bar but never the
  // downgrade one: spending less on an unmeasured hunch is the bad trade.
  if (confidence === null) return !isDowngrade
  return confidence >= bar
}

function said(confidence: number | null): string {
  return confidence === null ? 'confidence n/d' : `confidence ${confidence.toFixed(2)}`
}

/**
 * Turns a decision into a model and a reasoning level for the MAIN loop,
 * either of which may be null to leave the request as it is. Both can move in
 * either direction. Models are compared by rank, never by string, so the
 * session's `claude-opus-5-5[1m]` is the deep tier and keeps its suffix; a
 * model the router cannot place (`fable`) is never touched.
 */
export function route(
  decision: Decision | null,
  current: { model: string; effort?: string | number },
  config: PolicyConfig,
): Routing {
  if (!decision) return NOTHING

  let tier = decision.tier
  let effortScore = decision.effort
  let forced = false

  // Carrying out something final is never worth the saving: take the deep
  // tier and real reasoning, whatever the cheaper answer said, and skip the
  // thresholds — this is the one case that is not a confidence question.
  if (decision.risky !== null && decision.risky > RISKY_BAR) {
    tier = 'deep'
    effortScore = Math.max(effortScore ?? 0, 2)
    forced = true
  }

  const wantedModel = config.tiers[tier]
  const wantedRank = rankOf(wantedModel)
  const currentRank = rankOf(current.model)

  const model =
    wantedRank !== null &&
    currentRank !== null &&
    wantedRank !== currentRank &&
    // Risk raises the floor; it never moves the model down.
    (forced ? wantedRank > currentRank : allowed(wantedRank, currentRank, decision.confidence, config))
      ? wantedModel
      : null

  let effort: Effort | null = null
  // A model without effort (the request carries none) has nothing to adjust,
  // and a numeric effort is the caller's own scale, not this ladder.
  if (effortScore !== null && typeof current.effort === 'string') {
    const currentEffortRank = effortRank(current.effort)
    let wantedEffortRank = EFFORT_ORDER.indexOf(effortLevel(effortScore))
    // Risk raises the floor; it must never lower one.
    if (forced && currentEffortRank !== null) wantedEffortRank = Math.max(wantedEffortRank, currentEffortRank)
    if (
      wantedEffortRank !== currentEffortRank &&
      (forced || allowed(wantedEffortRank, currentEffortRank, decision.effortConfidence, config))
    ) {
      effort = EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, wantedEffortRank)] as Effort
    }
  }

  if (!model && !effort) {
    const wantedEffort = effortScore === null ? null : effortLevel(effortScore)
    const kept = `${current.model}${current.effort === undefined ? '' : `/${current.effort}`}`
    const wanted = `${wantedModel}${wantedEffort ? `/${wantedEffort}` : ''}`
    return { model: null, effort: null, reason: `kept ${kept}, wanted ${wanted} (${said(decision.confidence)})` }
  }
  return { model, effort, reason: forced ? `${tier}, forced by risk` : `${tier} (${said(decision.confidence)})` }
}

export interface SubagentRouting {
  /** Always set: the router names the model explicitly, whatever the caller passed. */
  model: Family
  effort: Effort
  reason: string
  /** True when no decision was used and the configured fallback applies. */
  fallback: boolean
}

/** What a subagent runs on when there is no usable decision. */
export function fallbackRouting(config: PolicyConfig, reason: string): SubagentRouting {
  return { model: config.fallbackModel, effort: config.fallbackEffort, reason, fallback: true }
}

/**
 * The model and effort for one subagent. There is no "current" model to
 * measure a change from: the caller's own `model` is overridden (callers pass
 * `sonnet` as a default, and the session's parent model says nothing about
 * what a subagent would have run on), so the decision is measured against the
 * FALLBACK, the configured default. A decision that agrees with it, or that
 * does not clear its bar, yields the fallback; one that does, yields its own
 * tier in either direction. `risky` takes the deep tier (never lower than the
 * fallback) and real reasoning past every bar.
 */
export function routeSubagent(decision: Decision | null, config: PolicyConfig): SubagentRouting {
  if (!decision) return fallbackRouting(config, 'no decision')

  let tier = decision.tier
  let score = decision.effort
  let forced = false
  if (decision.risky !== null && decision.risky > RISKY_BAR) {
    tier = 'deep'
    score = Math.max(score ?? 0, 2)
    forced = true
  }

  const fallbackModelRank = rankOf(config.fallbackModel) as number
  const wantedModel = config.tiers[tier]
  const wantedRank = rankOf(wantedModel) as number

  let model: Family = config.fallbackModel
  if (forced) {
    model = wantedRank >= fallbackModelRank ? wantedModel : config.fallbackModel
  } else if (allowed(wantedRank, fallbackModelRank, decision.confidence, config)) {
    model = wantedModel
  }

  const fallbackEffortRank = EFFORT_ORDER.indexOf(config.fallbackEffort)
  let effort: Effort = config.fallbackEffort
  let wantedEffort: Effort | null = null
  if (score !== null) {
    wantedEffort = effortLevel(score)
    let wantedEffortRank = EFFORT_ORDER.indexOf(wantedEffort)
    if (forced) {
      wantedEffortRank = Math.max(wantedEffortRank, fallbackEffortRank)
      effort = EFFORT_ORDER[wantedEffortRank] as Effort
    } else if (allowed(wantedEffortRank, fallbackEffortRank, decision.effortConfidence, config)) {
      effort = wantedEffort
    }
  }

  const stayed = !forced && (model !== wantedModel || (wantedEffort !== null && effort !== wantedEffort))
  const reason = forced
    ? `${tier}, forced by risk`
    : stayed
      ? `kept ${model}/${effort}, wanted ${wantedModel}${wantedEffort ? `/${wantedEffort}` : ''} (${said(decision.confidence)})`
      : `${tier} (${said(decision.confidence)})`
  return { model, effort, reason, fallback: false }
}

// ---- what leaves the machine ----------------------------------------------

/** The state sent to the decision model for a subagent, redacted then truncated. */
export function buildSubagentState(
  spawn: { prompt: string; description: string; subagentType: string },
  config: Pick<RouterConfig, 'redact' | 'maxPromptChars'>,
): { state: Record<string, string>; counts: RedactCounts } {
  const counts: RedactCounts = {}
  const field = (text: string, max: number) => {
    const out = prepareField(text, max, config.redact)
    mergeCounts(counts, out.counts)
    return out.text
  }
  return {
    state: {
      prompt: field(spawn.prompt, config.maxPromptChars),
      description: field(spawn.description, 500),
      agentType: field(spawn.subagentType, 100),
    },
    counts,
  }
}

/** The state sent for a main-loop prompt. */
export function buildPromptState(
  text: string,
  config: Pick<RouterConfig, 'redact' | 'maxPromptChars'>,
): { state: Record<string, string>; counts: RedactCounts } {
  const out = prepareField(text, config.maxPromptChars, config.redact)
  return { state: { prompt: out.text }, counts: out.counts }
}

// ---- state the hooks keep ------------------------------------------------

/** A short, stable key for a set of strings (two FNV-1a hashes and the length). */
export function hashKey(...parts: string[]): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  let length = 0
  for (const part of parts) {
    const text = `${part}\u0000`
    length += text.length
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      a = Math.imul(a ^ c, 0x01000193) >>> 0
      b = Math.imul(b + c, 0x85ebca6b) >>> 0
      b ^= b >>> 13
    }
  }
  return `${length.toString(36)}-${a.toString(36)}${b.toString(36)}`
}

/** Decisions by request key, so two identical spawns cost one call. Successes only. */
export function createDecisionCache(max = 200): {
  get(key: string): Decision | undefined
  set(key: string, decision: Decision): void
  size(): number
} {
  const entries = new Map<string, Decision>()
  return {
    get: (key) => entries.get(key),
    set(key, decision) {
      entries.delete(key)
      entries.set(key, decision)
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    size: () => entries.size,
  }
}

/**
 * Stops calling a backend that keeps failing, so a dead one costs the
 * timeout three times and not on every spawn. A rejected key (`fatal`) waits
 * far longer than a slow network.
 */
export function createBreaker(
  threshold = 3,
  cooldownMs = 30_000,
  fatalCooldownMs = 300_000,
): {
  allow(now: number): boolean
  success(): void
  failure(now: number, fatal?: boolean): void
} {
  let failures = 0
  let openUntil = 0
  return {
    allow: (now) => now >= openUntil,
    success() {
      failures = 0
      openUntil = 0
    },
    failure(now, fatal = false) {
      failures += 1
      if (fatal) openUntil = now + fatalCooldownMs
      else if (failures >= threshold) openUntil = now + cooldownMs
    },
  }
}

/** Failure classes the user is told about once, however often they recur. */
const ONCE_CLASSES = new Set(['no-key', 'config', 'override'])
const ESCALATE_AT = new Set([1, 5, 25, 100, 500, 2000])

/**
 * Decides when a failure is shown: the first of each class, then at 5, 25,
 * 100 and so on (the once-only classes only the first time, with or without a
 * `scope:` prefix such as `subagent:no-key`), so a dead backend is loud at the start and keeps a count
 * without a toast on every spawn.
 */
export function createNotifier(): { report(kind: string): { count: number; show: boolean } } {
  const counts = new Map<string, number>()
  return {
    report(kind) {
      const count = (counts.get(kind) ?? 0) + 1
      counts.set(kind, count)
      return { count, show: ONCE_CLASSES.has(kind.slice(kind.lastIndexOf(':') + 1)) ? count === 1 : ESCALATE_AT.has(count) }
    },
  }
}

/** The failure class of a non-2xx status. */
export function classifyStatus(status: number): { kind: string; fatal: boolean } {
  if (status === 401 || status === 403) return { kind: 'auth', fatal: true }
  if (status === 429) return { kind: 'rate-limit', fatal: false }
  if (status >= 500) return { kind: 'server', fatal: false }
  return { kind: 'http', fatal: false }
}

/** The line shown to the person when Jev could not decide. */
export function describeFailure(
  kind: string,
  count: number,
  config: { policy: PolicyConfig; timeoutMs: number },
  scope: 'subagent' | 'main' = 'subagent',
): string {
  const fb = `${config.policy.fallbackModel}/${config.policy.fallbackEffort}`
  const what: Record<string, string> = {
    timeout: `Jev did not answer within ${config.timeoutMs}ms`,
    auth: 'Jev rejected the API key (401/403)',
    'rate-limit': 'Jev is rate limiting (429)',
    server: 'Jev returned a server error (5xx)',
    http: 'Jev returned an HTTP error',
    malformed: 'Jev returned an answer the router could not read',
    network: 'the request to Jev failed',
    'circuit-open': 'Jev calls are paused after repeated failures',
    placeholder: 'a workflow agent got a withheld prompt (its run keeps the script private), so Jev cannot read the task',
    'no-key': 'no TypeSafe or Gateway API key is set for the chosen provider',
    classifier: 'the built-in classifier gave no usable answer',
    config: 'the router was configured with invalid options',
    override: 'the session forces the subagent model, so the router cannot choose it',
  }
  const times = count > 1 ? ` (${count} so far)` : ''
  if (kind === 'config' || kind === 'override') return `[jev-model-router] ${what[kind] ?? kind}${times}`
  const outcome = scope === 'main' ? 'the main loop runs unchanged' : `subagents run on the fallback ${fb}`
  return `[jev-model-router] ${what[kind] ?? kind}${times}: ${outcome}`
}

/**
 * Efforts waiting for their subagent, and bound to it once it has an id.
 *
 * `turn.step` carries the agent's id, and `agent.spawn`'s `next` settles with
 * it, but a subagent's `turn.start` is raised before that, and nothing orders
 * its first step against the spawn's return. So the effort is filed under the
 * prompt first (`turn.start` of the agent carries that prompt and its id),
 * and under the id too once `next` returns, whichever comes first.
 */
export function createEffortPlans(
  max = 256,
  ttlMs = 60_000,
): {
  expect(promptKey: string, effort: Effort | null, now?: number): number
  cancel(promptKey: string, effort: Effort | null, ticket?: number): void
  bind(agentId: string, promptKey: string, effort: Effort | null, ticket?: number, now?: number): void
  claim(agentId: string, promptKey: string, now?: number): void
  effortOf(agentId: string): Effort | undefined
  release(agentId: string): void
  size(): number
} {
  // `null` is a spawn that was NOT given an effort (skipped, unrouted). It is
  // queued like any other so that such an agent, whose turn.start carries the
  // same prompt as a routed spawn, takes its own entry and not the routed one.
  // Every entry has a ticket (its spawn removes exactly its own) and a time
  // (an entry nobody claimed within `ttlMs` is dropped, so a spawn that never
  // got an agent id cannot hand its effort to a later identical prompt).
  type Entry = { effort: Effort | null; ticket: number; at: number }
  const byAgent = new Map<string, Effort | null>()
  const waiting = new Map<string, Entry[]>()
  let nextTicket = 1
  let latest = 0
  const sweep = (now?: number) => {
    if (now !== undefined && now > latest) latest = now
    if (latest === 0) return
    for (const [key, queue] of waiting) {
      const fresh = queue.filter((entry) => latest - entry.at <= ttlMs)
      if (fresh.length === 0) waiting.delete(key)
      else if (fresh.length !== queue.length) waiting.set(key, fresh)
    }
  }
  const trim = () => {
    while (byAgent.size > max) {
      const oldest = byAgent.keys().next().value
      if (oldest === undefined) break
      byAgent.delete(oldest)
    }
    while (waiting.size > max) {
      const oldest = waiting.keys().next().value
      if (oldest === undefined) break
      waiting.delete(oldest)
    }
  }
  const take = (
    promptKey: string,
    effort?: Effort | null,
    ticket?: number,
  ): { found: boolean; effort: Effort | null } => {
    const queue = waiting.get(promptKey)
    if (!queue || queue.length === 0) return { found: false, effort: null }
    let index: number
    if (ticket !== undefined) index = queue.findIndex((entry) => entry.ticket === ticket)
    else if (effort === undefined) index = 0
    else index = queue.findIndex((entry) => entry.effort === effort)
    if (index === -1) return { found: false, effort: null }
    const [taken] = queue.splice(index, 1)
    if (queue.length === 0) waiting.delete(promptKey)
    return { found: true, effort: taken?.effort ?? null }
  }
  return {
    expect(promptKey, effort, now) {
      sweep(now)
      const queue = waiting.get(promptKey) ?? []
      const ticket = nextTicket++
      queue.push({ effort, ticket, at: latest })
      waiting.set(promptKey, queue)
      trim()
      return ticket
    },
    cancel(promptKey, effort, ticket) {
      // With a ticket, only that spawn's own entry goes; without one, the
      // first entry of this effort.
      take(promptKey, effort, ticket)
    },
    bind(agentId, promptKey, effort, ticket, now) {
      sweep(now)
      // An agent that already claimed its entry at turn.start must not take a
      // second one: that belongs to another spawn with the same prompt.
      if (byAgent.has(agentId)) return
      take(promptKey, effort, ticket)
      byAgent.set(agentId, effort)
      trim()
    },
    claim(agentId, promptKey, now) {
      sweep(now)
      if (byAgent.has(agentId)) return
      const taken = take(promptKey)
      if (taken.found) byAgent.set(agentId, taken.effort)
      trim()
    },
    effortOf: (agentId) => byAgent.get(agentId) ?? undefined,
    release(agentId) {
      byAgent.delete(agentId)
    },
    size: () => byAgent.size + [...waiting.values()].reduce((n, q) => n + q.length, 0),
  }
}

/**
 * Main-loop decisions waiting for the turn that reads their prompt.
 *
 * A decision is tied to its prompt's TEXT, and claimed by the turn whose
 * `turn.start` carries that text. Counting prompts (the earlier design) went
 * out of step as soon as a prompt never started a turn: a command, a prompt a
 * higher hook dropped, one merged into a queued turn. Identity cannot drift:
 * a turn either finds its own prompt or runs unrouted.
 */
export function createPendingPrompts(max = 8): {
  put(text: string, decision: Decision | null): void
  claim(turnText: string): Decision | null
  size(): number
} {
  let held: { text: string; decision: Decision | null }[] = []
  return {
    put(text, decision) {
      held.push({ text: text.trim(), decision })
      if (held.length > max) held = held.slice(held.length - max)
    },
    claim(turnText) {
      const turn = turnText.trim()
      if (!turn) return null
      let chosen = -1
      for (let i = held.length - 1; i >= 0; i--) {
        if ((held[i] as { text: string }).text === turn) {
          chosen = i
          break
        }
      }
      if (chosen === -1) {
        // The turn may carry the prompt among others (queued prompts merged).
        // One containing match is a fit; several is a guess, and a guess is
        // worse than not routing.
        const inside = held
          .map((h, i) => ({ h, i }))
          .filter(({ h }) => h.text.length > 0 && turn.includes(h.text))
        if (inside.length === 1) chosen = (inside[0] as { i: number }).i
      }
      if (chosen === -1) return null
      const decision = (held[chosen] as { decision: Decision | null }).decision
      held = held.slice(chosen + 1)
      return decision
    },
    size: () => held.length,
  }
}

/**
 * The prompt Claude Code 2.1.305 gives a workflow agent on a run that keeps its
 * script out of SDK events: the literal string
 * `(withheld: this workflow run does not share its script)`, found in the
 * binary at the spawn site (`prompt: <hidden> ? "(withheld: ...)" : script
 * prompt`). It is matched exactly (after trimming), plus the same
 * parenthesised `withheld:` notice naming the script, so a reworded future
 * release still matches. A prompt is never read as a placeholder because it
 * is short, repeated or empty: N agents with one prompt are N real tasks.
 */
const PLACEHOLDER_EXACT = '(withheld: this workflow run does not share its script)'
const PLACEHOLDER_SHAPE = /^\(withheld:[^()\n]{0,120}\bscript\b[^()\n]{0,60}\)$/i

/** Whether a workflow agent's prompt is the fixed hidden-script placeholder. */
export function isHiddenScriptPlaceholder(workflow: unknown, prompt: string): boolean {
  if (!workflow) return false
  const text = prompt.trim()
  return text === PLACEHOLDER_EXACT || PLACEHOLDER_SHAPE.test(text)
}

/** Why a spawn is not routed, and of which kind. */
export interface Skip {
  kind: 'resume' | 'fork' | 'teammate' | 'placeholder'
  reason: string
}

/**
 * Why a spawn gets no Jev call, or null to route it. A fork inherits its
 * parent's model; a teammate's model is left out by the engine; a resume's
 * content is pinned (these three are legitimately unroutable); a hidden-script
 * workflow agent's prompt is a placeholder the decision model cannot read (the
 * caller applies the fallback and says so).
 */
export function skipReason(spawn: {
  fork?: boolean
  isTeammate?: true
  resume?: unknown
  workflow?: { runId: string; agentIndex: number }
  prompt: string
}): Skip | null {
  if (spawn.resume) return { kind: 'resume', reason: 'a resumed agent' }
  if (spawn.fork) return { kind: 'fork', reason: 'a fork (inherits its parent)' }
  if (spawn.isTeammate) return { kind: 'teammate', reason: 'a teammate' }
  if (isHiddenScriptPlaceholder(spawn.workflow, spawn.prompt)) {
    return { kind: 'placeholder', reason: 'a workflow agent whose prompt the run withholds' }
  }
  return null
}

/**
 * Whether a prompt is a slash command and nothing else (`/simplify`). The
 * decision model sees only the name, never the skill or command it runs.
 */
export function bareCommand(text: string): boolean {
  return /^\/[^\s/]+$/.test(text.trim())
}

/** Whether a prompt came from the person (their own Enter, a bridge, the SDK host). */
export function fromPerson(origin: { kind: string } | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge' || origin?.kind === 'sdk'
}

// ---- describing ----------------------------------------------------------

/** A number for the log, or `n/d` when the backend reported none. */
function reported(value: number | null): string {
  return value === null ? 'n/d' : value.toFixed(2)
}

/**
 * The one-time line that says the router is alive, which backend answers it,
 * and what it routes.
 */
export function describeSetup(config: RouterConfig): string {
  const backend =
    config.mode === 'jev'
      ? `${config.provider} (${config.url})`
      : config.mode === 'builtin'
        ? 'the built-in classifier, by choice'
        : `no key: subagents run on the fallback ${config.policy.fallbackModel}/${config.policy.fallbackEffort}`
  const on = [
    config.routeSubagentModel && 'subagent model',
    config.routeSubagentEffort && 'subagent effort',
    config.routeMainEffort && 'main effort',
    config.routeMainModel && 'main model',
  ].filter(Boolean)
  const privacy = config.mode === 'jev' ? `; redaction ${config.redactSensitive ? 'on' : 'OFF'}` : ''
  return `ready on ${backend}; routing ${on.length > 0 ? on.join(', ') : 'nothing, every switch is off'}${privacy}`
}

/** What the decision model answered, before any policy touches it. */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)}ms`
  if (!decision) return `no answer${took}`

  const parts = [`tier ${decision.tier} (${reported(decision.confidence)})`]
  if (decision.effort !== null) {
    parts.push(
      `effort ${decision.effort.toFixed(1)} → ${effortLevel(decision.effort)} (${reported(decision.effortConfidence)})`,
    )
  }
  if (decision.risky !== null) parts.push(`risky ${reported(decision.risky)}`)
  return parts.join(' · ') + took
}

/** The persistent status line: the last thing the router did. */
export function describeStatus(
  decision: Decision | null,
  change: { model?: string; effort?: Effort } | null,
): string {
  if (!decision) return 'jev · no answer'
  const asked = `${decision.tier} ${reported(decision.confidence)}`
  if (!change) return `jev · ${asked} · unchanged`
  const to = [change.model, change.effort].filter(Boolean).join('/')
  return `jev · ${asked} → ${to}`
}
