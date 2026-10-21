/**
 * jev-model-router — Claude Mod
 *
 * Picks the model AND the reasoning effort of each SUBAGENT with TypeSafe's
 * Jev, a System One decision model: unstructured state in, a typed choice with
 * a probability distribution out.
 *
 * What it routes:
 *   agent.spawn  — the model of every subagent the Agent tool or a Workflow
 *                  `agent()` starts (haiku, sonnet or opus; the caller's own
 *                  `model` is overridden, Jev decides)
 *   turn.step    — that subagent's effort (low..xhigh, never max), looked up
 *                  by the agent's id, which `agent.spawn` hands back
 *   turn.complete— drops the agent's entry
 * The main conversation is NOT routed unless `routeMainEffort` or
 * `routeMainModel` is switched on; with both off `prompt.submit` makes no
 * call at all, so no prompt of yours leaves the machine.
 *
 * Failure is loud, not silent. When Jev cannot decide (timeout, HTTP error,
 * unreadable answer, no key), the subagent runs on `fallbackModel` /
 * `fallbackEffort`, both applied explicitly, and the person is told with a
 * toast and a transcript line (once per kind of failure, and again at 5, 25,
 * 100 ... occurrences).
 *
 * What leaves the machine: only the subagent's prompt (cut to
 * `maxPromptChars`), description and agent type, after a best-effort
 * secret-redaction pass (see redact.ts). Never the API key beyond its
 * Authorization header, and never in any log.
 *
 * Needs Claude Code >= 2.1.287. Typed against Anthropic's declarations.
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  TIER_ORDER,
  bareCommand,
  buildPromptState,
  buildSubagentState,
  classifyStatus,
  createBreaker,
  createDecisionCache,
  createEffortPlans,
  createNotifier,
  createPendingPrompts,
  createPlaceholderGuard,
  describeDecision,
  describeFailure,
  describeSetup,
  describeStatus,
  fallbackRouting,
  fromPerson,
  hashKey,
  isTier,
  rankOf,
  readDecision,
  requestBody,
  requestHeaders,
  requestModelId,
  resolveOptions,
  route,
  routeSubagent,
  skipReason,
} from './policy.ts'
import type { Decision, Effort, RouterConfig } from './policy.ts'
import { describeCounts, scrubForLog } from './redact.ts'
import type { RedactCounts } from './redact.ts'

type Dollar = EngineInterface

/** What a call to the decision model came to. */
interface Outcome {
  decision: Decision | null
  /** The failure kind (see describeFailure), or null on success. */
  failure: string | null
  fatal: boolean
}

/** One loud line: a toast on a surface that has one, and always a transcript row. */
function loud($: Dollar, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // A surface with no toast still gets the transcript line below.
  }
  $.ui.log(text)
}

/**
 * Posts the state to the decision model, bounded by the latency budget. A
 * request that outlives the budget is not cancelled (the API has no abort);
 * the breaker is what stops the next ones.
 */
async function askJev(
  $: Dollar,
  config: RouterConfig,
  state: Record<string, string>,
): Promise<Outcome> {
  const provider = config.provider
  if (!provider) return { decision: null, failure: 'no-key', fatal: false }
  try {
    const response = await Promise.race([
      $.http.fetch(config.url, {
        method: 'POST',
        headers: requestHeaders(provider, config.apiKey, config.modelId),
        body: requestBody(provider, state, config.modelId),
      }),
      $.clock.sleep(config.timeoutMs),
    ])
    if (!response) return { decision: null, failure: 'timeout', fatal: false }
    if (!response.ok) {
      const { kind, fatal } = classifyStatus(response.status)
      return { decision: null, failure: kind, fatal }
    }
    const decision = readDecision(response.text)
    return decision
      ? { decision, failure: null, fatal: false }
      : { decision: null, failure: 'malformed', fatal: false }
  } catch (error) {
    $.ui.log(`[jev-model-router] request failed: ${scrubForLog(String(error))}`, { to: 'debug' })
    return { decision: null, failure: 'network', fatal: false }
  }
}

/** The engine's own small-model classifier, used only when `provider` is "builtin". */
async function askBuiltin($: Dollar, text: string): Promise<Outcome> {
  try {
    const label = await $.model.classify(text, TIER_ORDER)
    if (isTier(label)) {
      const decision: Decision = {
        tier: label,
        confidence: null,
        risky: null,
        effort: null,
        effortConfidence: null,
      }
      return { decision, failure: null, fatal: false }
    }
  } catch (error) {
    $.ui.log(`[jev-model-router] built-in classifier failed: ${scrubForLog(String(error))}`, { to: 'debug' })
  }
  return { decision: null, failure: 'classifier', fatal: false }
}

/** Everything the helpers that take `$` need besides `$` itself. */
interface Ctx {
  config: RouterConfig
  warnings: string[]
  notifier: ReturnType<typeof createNotifier>
  flags: { announced: boolean; fallbacks: number; status: string }
}

/** The one-time "I am alive" line, and the one-time list of option problems. */
function announce($: Dollar, ctx: Ctx): void {
  if (ctx.flags.announced) return
  ctx.flags.announced = true
  if (ctx.config.logDecisions) $.ui.log(`[jev-model-router] ${describeSetup(ctx.config)}`)
  if (ctx.warnings.length > 0) {
    ctx.notifier.report('config')
    loud($, `[jev-model-router] ignoring invalid options: ${ctx.warnings.join('; ')}`)
  }
}

/** Counts a failure and shows it when it is the first of its kind, or an escalation. */
function reportFailure($: Dollar, ctx: Ctx, kind: string, scope: 'subagent' | 'main'): void {
  const { count, show } = ctx.notifier.report(`${scope}:${kind}`)
  if (scope === 'subagent') ctx.flags.fallbacks += 1
  if (show) loud($, describeFailure(kind, count, ctx.config, scope))
  // The status line follows the real count, not only the shown notices; a
  // class that never changes (keyless) is written once.
  if (scope === 'subagent') {
    const line = kind === 'no-key' ? 'jev · keyless, fallback model' : `jev · fallback ×${ctx.flags.fallbacks} (${kind})`
    if (line !== ctx.flags.status) {
      ctx.flags.status = line
      $.ui.status(line)
    }
  }
}

export const register: Register = (on, options) => {
  const { config, warnings } = resolveOptions(options)
  const policy = config.policy

  const breaker = createBreaker()
  const cache = createDecisionCache()
  const notifier = createNotifier()
  const plans = createEffortPlans()
  const guard = createPlaceholderGuard()
  const pending = createPendingPrompts()
  // Main-loop bookkeeping, per turn, dropped at turn.complete.
  const claimed = new Map<string, Decision | null>()
  const mainPlans = new Map<string, { model?: string; effort?: Effort } | null>()

  const flags = { announced: false, fallbacks: 0, status: '' }

  const ctx: Ctx = { config, warnings, notifier, flags }

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      // The subagent's own turn: its text is the prompt it was spawned with,
      // and its id is what turn.step will carry.
      plans.claim(e.agentId, hashKey(e.text))
    } else if (config.routeMainLoop) {
      claimed.set(e.turnId, pending.claim(e.text))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      plans.release(e.agentId)
    } else {
      claimed.delete(e.turnId)
      mainPlans.delete(e.turnId)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    announce($, ctx)
    // Main-loop routing is off by default. Off means no call of any kind:
    // nothing the person types is classified, sent, or even hashed.
    if (!config.routeMainLoop) return next(e)

    // Only what the person typed. A notification, a peer's message, a
    // schedule or another plugin's prompt is not theirs to route, and a
    // command line or a bare slash command says nothing about the task.
    if (e.isMeta || e.command || !fromPerson(e.origin) || bareCommand(e.text)) return next(e)

    if (config.mode === 'keyless') {
      reportFailure($, ctx, 'no-key', 'main')
      return next(e)
    }

    let outcome: Outcome
    let counts: RedactCounts = {}
    const startedAt = await $.clock.now()
    if (config.mode === 'jev') {
      if (!breaker.allow(startedAt)) {
        outcome = { decision: null, failure: 'circuit-open', fatal: false }
      } else {
        const built = buildPromptState(e.text, config)
        counts = built.counts
        outcome = await askJev($, config, built.state)
        if (outcome.failure) breaker.failure(startedAt, outcome.fatal)
        else breaker.success()
      }
    } else {
      const built = buildPromptState(e.text, config)
      counts = built.counts
      outcome = await askBuiltin($, built.state.prompt ?? '')
    }

    if (outcome.failure) reportFailure($, ctx, outcome.failure, 'main')
    if (config.logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      const redacted = describeCounts(counts)
      $.ui.log(`[jev-model-router] jev: ${describeDecision(outcome.decision, ms)}${redacted ? ` · ${redacted}` : ''}`)
    }
    pending.put(e.text, outcome.decision)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent's step: its effort was decided at agent.spawn.
    if (e.agentId) {
      const wanted = plans.effortOf(e.agentId)
      // A model without effort carries none to adjust.
      if (wanted && e.effort !== undefined && e.effort !== wanted) {
        return yield* next({ ...e, effort: wanted })
      }
      return yield* next(e)
    }

    if (!config.routeMainLoop) return yield* next(e)

    // The first request of a turn settles the plan; every later one reuses it,
    // so neither the model nor the effort changes under its own tool loop.
    if (!mainPlans.has(e.turnId)) {
      const decision = claimed.get(e.turnId) ?? null
      claimed.delete(e.turnId)
      const routing = route(decision, { model: e.model, effort: e.effort }, policy)
      const change: { model?: string; effort?: Effort } = {}
      // The main loop's `model` is sent to the API as written, so an alias
      // becomes its id here; a subagent's (agent.spawn) stays an alias.
      if (config.routeMainModel && routing.model) change.model = requestModelId(routing.model)
      if (config.routeMainEffort && routing.effort) change.effort = routing.effort
      const applied = Object.keys(change).length > 0 ? change : null
      mainPlans.set(e.turnId, applied)
      if (config.logDecisions) {
        $.ui.status(describeStatus(decision, applied))
        if (applied) {
          const what = [applied.model, applied.effort && `effort ${applied.effort}`].filter(Boolean).join(', ')
          $.ui.log(`[jev-model-router] main loop → ${what}: ${routing.reason}`)
        } else {
          const suppressed = routing.model && !config.routeMainModel ? ' (main-loop model routing off)' : ''
          $.ui.log(`[jev-model-router] main loop: ${routing.reason}${suppressed}`)
        }
      }
    }
    const applied = mainPlans.get(e.turnId) ?? null
    return yield* next(applied ? { ...e, ...applied } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    announce($, ctx)
    if (!config.routeSubagentModel && !config.routeSubagentEffort) return next(e)

    // Files the effort (or its absence) under the prompt before starting the
    // agent, because its own turn.start may come before `next` returns, and
    // under its id after. Every spawn that reaches `next` files an entry, so
    // no agent can take another spawn's.
    const launch = async (ev: typeof e, effort: Effort | null) => {
      const promptKey = hashKey(ev.prompt)
      plans.expect(promptKey, effort)
      let result
      try {
        result = await next(ev)
      } catch (error) {
        plans.cancel(promptKey, effort)
        throw error
      }
      if (result.deny !== undefined) {
        plans.cancel(promptKey, effort)
        return result
      }
      if (result.agentId) plans.bind(result.agentId, promptKey, effort)
      return result
    }

    // Forks, teammates, resumes and hidden-script workflow agents: no call.
    const skip = skipReason(e, guard)
    if (skip) {
      if (config.logDecisions) {
        $.ui.log(`[jev-model-router] ${e.subagentType}: left alone, ${skip}`, { to: 'debug' })
      }
      return launch(e, null)
    }

    // 1. A decision: from the cache, from Jev, from the built-in classifier,
    //    or none (and then why).
    const key = hashKey(e.subagentType, e.description, e.prompt)
    let decision: Decision | null = cache.get(key) ?? null
    let failure: string | null = null
    let counts: RedactCounts = {}
    const startedAt = await $.clock.now()
    let cached = decision !== null

    if (!decision) {
      if (config.mode === 'keyless') {
        failure = 'no-key'
      } else if (config.mode === 'jev' && !breaker.allow(startedAt)) {
        failure = 'circuit-open'
      } else {
        const built = buildSubagentState(e, config)
        counts = built.counts
        const outcome =
          config.mode === 'jev'
            ? await askJev($, config, built.state)
            : await askBuiltin($, built.state.prompt ?? '')
        decision = outcome.decision
        failure = outcome.failure
        if (config.mode === 'jev') {
          if (failure) breaker.failure(startedAt, outcome.fatal)
          else breaker.success()
        }
        if (decision) cache.set(key, decision)
      }
    }
    cached = cached && decision !== null

    if (failure) reportFailure($, ctx, failure, 'subagent')
    if (config.logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      const redacted = describeCounts(counts)
      const shown = failure ?? describeDecision(decision, cached ? null : ms)
      $.ui.log(
        `[jev-model-router] jev (${e.subagentType}${cached ? ', cached' : ''}): ${shown}${redacted ? ` · ${redacted}` : ''}`,
      )
    }

    // 2. What it means for this subagent. A model is ALWAYS named: the
    //    caller's own (callers pass a default) and the parent's are replaced.
    const routing = decision ? routeSubagent(decision, policy) : fallbackRouting(policy, failure ?? 'no decision')
    const model = config.routeSubagentModel ? routing.model : undefined
    const effort = config.routeSubagentEffort ? routing.effort : undefined

    // 3. Start it.
    const result = await launch(model ? { ...e, model } : e, effort ?? null)
    if (result.deny !== undefined) return result

    if (config.logDecisions) {
      const what = [model, effort].filter(Boolean).join('/')
      $.ui.log(`[jev-model-router] ${e.subagentType} → ${what}${routing.fallback ? ' (fallback)' : ''}: ${routing.reason}`)
    }

    // 4. If the session forces a subagent model (CLAUDE_CODE_SUBAGENT_MODEL
    //    outranks a hook for some spawns), say so once instead of pretending.
    if (model) {
      const chosen = rankOf(model)
      const ran = rankOf(result.model)
      if (chosen !== null && ran !== null && chosen !== ran) {
        const { show } = notifier.report('override')
        if (show) {
          loud(
            $,
            `${describeFailure('override', 1, config)}: wanted ${model}, it runs on ${result.model}`,
          )
        }
      }
    }
    return result
  })
}
