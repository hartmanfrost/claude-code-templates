import { expect, test } from 'claude-code/testing'
import {
  buildPromptState,
  buildSubagentState,
  classifyStatus,
  createBreaker,
  createDecisionCache,
  createEffortPlans,
  createNotifier,
  createPendingPrompts,
  isHiddenScriptPlaceholder,
  describeFailure,
  describeSetup,
  fallbackRouting,
  fromPerson,
  hashKey,
  parseFamily,
  rankOf,
  readDecision,
  requestModelId,
  resolveOptions,
  route,
  routeSubagent,
  skipReason,
  validateBaseUrl,
} from '../hooks/policy.ts'
import type { Decision, PolicyConfig } from '../hooks/policy.ts'
import { DEFAULT_REDACT } from '../hooks/redact.ts'

const config: PolicyConfig = {
  tiers: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  fallbackModel: 'opus',
  fallbackEffort: 'medium',
}

const decide = (
  tier: Decision['tier'],
  confidence: number | null,
  effort: number | null = 1.4,
  effortConfidence: number | null = 0.9,
  risky: number | null = 0.01,
): Decision => ({ tier, confidence, effort, effortConfidence, risky })

// --- subagent routing: the model is always named -----------------------------------

test('a confident cheap decision goes down from the fallback, model and effort', () => {
  const routing = routeSubagent(decide('fast', 0.95, 0.1, 0.9), config)
  expect(routing.model).toBe('haiku')
  expect(routing.effort).toBe('low')
  expect(routing.fallback).toBe(false)
})

test('a decision that does not clear the downgrade bar keeps the fallback', () => {
  const routing = routeSubagent(decide('fast', 0.51, 0.1, 0.5), config)
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('medium')
  expect(routing.reason).toBe('kept opus/medium, wanted haiku/low (confidence 0.51)')
})

test('with a lower fallback, a modest-confidence upgrade clears the low bar', () => {
  const low: PolicyConfig = { ...config, fallbackModel: 'sonnet', fallbackEffort: 'low' }
  const routing = routeSubagent(decide('deep', 0.31, 2.8, 0.31), low)
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('xhigh')
})

test('a deep decision names opus explicitly even where the parent is opus[1m]', () => {
  // The baseline compared against `e.model ?? e.parentModel`, so with a parent
  // on opus[1m] and a subagent actually running sonnet "deep" looked like no
  // change. The decision no longer depends on what the caller or parent run.
  const routing = routeSubagent(decide('deep', 0.9), { ...config, fallbackModel: 'sonnet' })
  expect(routing.model).toBe('opus')
})

test('no confidence means the decision may only go up from the fallback', () => {
  expect(routeSubagent(decide('fast', null, null, null), config).model).toBe('opus')
  expect(routeSubagent(decide('deep', null, null, null), { ...config, fallbackModel: 'sonnet' }).model).toBe('opus')
  expect(routeSubagent(decide('balanced', null, 0.1, null), config).effort).toBe('medium')
})

test('a risky task takes the deep tier and real reasoning past every bar', () => {
  const routing = routeSubagent(decide('fast', 0.97, 0, 0.9, 0.93), { ...config, fallbackModel: 'sonnet' })
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('high')
  expect(routing.reason).toContain('risk')
})

test('risk never lowers the fallback effort', () => {
  const routing = routeSubagent(decide('fast', 0.97, 0, 0.9, 0.93), { ...config, fallbackEffort: 'xhigh' })
  expect(routing.effort).toBe('xhigh')
})

test('the effort is never max and the model is always a family alias', () => {
  for (const score of [0, 1, 2, 3, 99]) {
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      const routing = routeSubagent(decide(tier, 0.99, score, 0.99), config)
      expect(['low', 'medium', 'high', 'xhigh']).toContain(routing.effort)
      expect(['haiku', 'sonnet', 'opus']).toContain(routing.model)
    }
  }
})

test('a missing effort score falls back to the fallback effort', () => {
  expect(routeSubagent(decide('fast', 0.99, null, null), config).effort).toBe('medium')
})

test('no decision is the fallback, flagged as such', () => {
  const routing = routeSubagent(null, config)
  expect(routing).toEqual(fallbackRouting(config, 'no decision'))
  expect(routing.fallback).toBe(true)
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('medium')
})

// --- main loop: ranks, not strings ---------------------------------------------------

test('a risky task on opus[1m] keeps its exact model id', () => {
  const routing = route(decide('fast', 0.99, 0, 0.9, 0.95), { model: 'claude-opus-5-5[1m]', effort: 'high' }, config)
  expect(routing.model).toBeNull()
})

test('a risky task on a cheaper model is raised by rank', () => {
  const routing = route(decide('fast', 0.99, 0, 0.9, 0.95), { model: 'claude-sonnet-5-5', effort: 'medium' }, config)
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('high')
})

test('a model the router cannot place is never touched', () => {
  for (const model of ['claude-fable-1', 'some-other-vendor-model']) {
    expect(rankOf(model)).toBeNull()
    expect(route(decide('fast', 0.99), { model, effort: 'high' }, config).model).toBeNull()
    expect(route(decide('deep', 0.99, 1, 0.9, 0.99), { model, effort: 'high' }, config).model).toBeNull()
  }
})

test('a request without an effort gets none written onto it', () => {
  const routing = route(decide('fast', 0.99, 0.1, 0.99), { model: 'claude-haiku-5-5' }, config)
  expect(routing.effort).toBeNull()
})

test('rank is read from the family word, case-insensitively', () => {
  expect(rankOf('claude-HAIKU-5-5')).toBe(0)
  expect(rankOf('claude-sonnet-5-5[1m]')).toBe(1)
  expect(rankOf('opus')).toBe(2)
})

test('family aliases resolve to the ids this build reported', () => {
  expect(requestModelId('haiku')).toBe('claude-haiku-5-5')
  expect(requestModelId('Sonnet')).toBe('claude-sonnet-5-5')
  expect(requestModelId('opus')).toBe('claude-opus-5-5')
  expect(requestModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
})

// --- options ---------------------------------------------------------------------------

test('the defaults route subagents only, make no main-loop call, and fall back to opus/medium', () => {
  const { config: c, warnings } = resolveOptions({})
  expect(warnings).toEqual([])
  expect(c.routeMainLoop).toBe(false)
  expect(c.routeMainEffort).toBe(false)
  expect(c.routeMainModel).toBe(false)
  expect(c.routeSubagentModel).toBe(true)
  expect(c.routeSubagentEffort).toBe(true)
  expect(c.policy.fallbackModel).toBe('opus')
  expect(c.policy.fallbackEffort).toBe('medium')
  expect(c.redactSensitive).toBe(true)
  expect(c.redact.enabled).toBe(true)
  expect(c.redact.emails).toBe(false)
  expect(c.redact.ips).toBe(false)
  expect(c.redact.homePaths).toBe(false)
  expect(c.maxPromptChars).toBe(4000)
  expect(c.mode).toBe('keyless')
})

test('no key is keyless, never the built-in classifier; builtin must be chosen', () => {
  expect(resolveOptions({}).config.mode).toBe('keyless')
  expect(resolveOptions({ provider: 'auto' }).config.mode).toBe('keyless')
  expect(resolveOptions({ provider: 'typesafe', gatewayApiKey: 'g' }).config.mode).toBe('keyless')
  expect(resolveOptions({ provider: 'builtin' }).config.mode).toBe('builtin')
  expect(resolveOptions({ typesafeApiKey: 'k' }).config.mode).toBe('jev')
  expect(resolveOptions({ typesafeApiKey: 'k' }).config.provider).toBe('typesafe')
  expect(resolveOptions({ gatewayApiKey: 'k' }).config.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model')
})

test('only haiku, sonnet and opus are accepted as models, and nothing fable-like', () => {
  expect(parseFamily('Opus')).toBe('opus')
  for (const bad of ['fable', 'claude-fable-1', 'opus[1m]', 'claude-opus-5-5', '', 3, undefined]) {
    expect(parseFamily(bad)).toBeNull()
  }
  const { config: c, warnings } = resolveOptions({ fallbackModel: 'fable', deepModel: 'gpt-5', fastModel: 'haiku' })
  expect(c.policy.fallbackModel).toBe('opus')
  expect(c.policy.tiers.deep).toBe('opus')
  expect(warnings.length).toBe(2)
})

test('the effort options allow low to xhigh and never max', () => {
  expect(resolveOptions({ fallbackEffort: 'xhigh' }).config.policy.fallbackEffort).toBe('xhigh')
  const bad = resolveOptions({ fallbackEffort: 'max' })
  expect(bad.config.policy.fallbackEffort).toBe('medium')
  expect(bad.warnings.length).toBe(1)
})

test('numbers outside their range fall back to the default and are reported', () => {
  const { config: c, warnings } = resolveOptions({
    timeoutMs: -5,
    minUpgradeConfidence: 2,
    minDowngradeConfidence: 'high',
    maxPromptChars: 5,
  })
  expect(c.timeoutMs).toBe(1500)
  expect(c.policy.minUpgradeConfidence).toBe(0.3)
  expect(c.policy.minDowngradeConfidence).toBe(0.6)
  expect(c.maxPromptChars).toBe(4000)
  expect(warnings.length).toBe(4)
})

test('a wrong-typed flag and an unknown provider are reported, not silently ignored', () => {
  const { config: c, warnings } = resolveOptions({ routeSubagentModel: 'yes', provider: 'openai' })
  expect(c.routeSubagentModel).toBe(true)
  expect(c.forced).toBe('auto')
  expect(warnings.length).toBe(2)
})

test('turning a main-loop switch on is what enables main-loop routing', () => {
  expect(resolveOptions({ routeMainEffort: true }).config.routeMainLoop).toBe(true)
  expect(resolveOptions({ routeMainModel: true }).config.routeMainLoop).toBe(true)
})

test('base URLs must be https, or http on loopback, without credentials', () => {
  expect(validateBaseUrl('https://api.typesafe.ai')).toBeNull()
  expect(validateBaseUrl('http://localhost:8080')).toBeNull()
  expect(validateBaseUrl('http://127.0.0.1:9000/x')).toBeNull()
  expect(validateBaseUrl('http://[::1]:9000')).toBeNull()
  expect(validateBaseUrl('http://api.typesafe.ai')).not.toBeNull()
  expect(validateBaseUrl('ftp://example.com')).not.toBeNull()
  expect(validateBaseUrl('https://user:pw@example.com')).not.toBeNull()
  expect(validateBaseUrl('not a url')).not.toBeNull()
  expect(validateBaseUrl('http://localhost.evil.example')).not.toBeNull()
})

test('an unsafe base URL is ignored for the default, with a warning, and the key goes to the default host', () => {
  const { config: c, warnings } = resolveOptions({ typesafeApiKey: 'k', typesafeBaseUrl: 'http://evil.example.com' })
  expect(c.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(warnings.length).toBe(1)
  expect(warnings[0]).not.toContain('k')
})

test('invalid redaction patterns are reported once through the option warnings', () => {
  const { config: c, warnings } = resolveOptions({ redactPatterns: '([\nok-[0-9]+' })
  expect(c.redact.custom.length).toBe(1)
  expect(warnings.length).toBe(1)
})

test('the setup line says what is routed and whether redaction is on', () => {
  const keyed = resolveOptions({ typesafeApiKey: 'k' }).config
  expect(describeSetup(keyed)).toBe(
    'ready on typesafe (https://api.typesafe.ai/v1/systemone); routing subagent model, subagent effort; redaction on',
  )
  const keyless = resolveOptions({}).config
  expect(describeSetup(keyless)).toContain('no key: subagents run on the fallback opus/medium')
  const off = resolveOptions({ typesafeApiKey: 'k', redactSensitive: false }).config
  expect(describeSetup(off)).toContain('redaction OFF')
  const none = resolveOptions({ routeSubagentModel: false, routeSubagentEffort: false }).config
  expect(describeSetup(none)).toContain('nothing, every switch is off')
})

// --- classifier answers -----------------------------------------------------------------

test('probabilities and scores outside their range read as absent', () => {
  const decision = readDecision(
    JSON.stringify({
      answers: {
        tier: { choice: 'deep', confidence: 7 },
        effort: { score: 99, confidence: -1 },
        risky: { noul: 3 },
      },
    }),
  )
  expect(decision?.confidence).toBeNull()
  expect(decision?.effortConfidence).toBeNull()
  expect(decision?.risky).toBeNull()
  expect(decision?.effort).toBe(3)
  expect(readDecision('[1,2]')).toBeNull()
  expect(readDecision('null')).toBeNull()
  expect(readDecision(JSON.stringify({ answers: 'x' }))).toBeNull()
})

// --- effort plans: agent id vs prompt -----------------------------------------------------------

test('an effort filed at spawn reaches the agent whose turn.start carries the same prompt', () => {
  const plans = createEffortPlans()
  const key = hashKey('do the thing')
  plans.expect(key, 'low')
  plans.claim('agent-1', key)
  expect(plans.effortOf('agent-1')).toBe('low')
})

test('the id from agent.spawn binds it too, whichever comes first', () => {
  const plans = createEffortPlans()
  const key = hashKey('p')
  plans.expect(key, 'high')
  plans.bind('a', key, 'high')
  expect(plans.effortOf('a')).toBe('high')
  plans.claim('a', key)
  expect(plans.effortOf('a')).toBe('high')
  // The waiting entry was consumed, so it cannot leak onto a later agent.
  plans.claim('b', key)
  expect(plans.effortOf('b')).toBeUndefined()
})

test('turn.start first, then the spawn result, binds once and leaves nothing waiting', () => {
  const plans = createEffortPlans()
  const key = hashKey('p')
  plans.expect(key, 'xhigh')
  plans.claim('a', key)
  plans.bind('a', key, 'xhigh')
  expect(plans.effortOf('a')).toBe('xhigh')
  expect(plans.size()).toBe(1)
})

test('two agents spawned with the same prompt each get their own entry', () => {
  const plans = createEffortPlans()
  const key = hashKey('same')
  plans.expect(key, 'low')
  plans.expect(key, 'low')
  plans.claim('a', key)
  plans.claim('b', key)
  expect(plans.effortOf('a')).toBe('low')
  expect(plans.effortOf('b')).toBe('low')
})

test('the entry is dropped at the end of the agent and on a refused spawn', () => {
  const plans = createEffortPlans()
  const key = hashKey('p')
  plans.expect(key, 'low')
  plans.claim('a', key)
  plans.release('a')
  expect(plans.effortOf('a')).toBeUndefined()
  expect(plans.size()).toBe(0)

  plans.expect(key, 'low')
  plans.cancel(key, 'low')
  expect(plans.size()).toBe(0)
})

test('an agent that was never planned has no effort to apply', () => {
  const plans = createEffortPlans()
  plans.claim('resumed', hashKey('x'))
  expect(plans.effortOf('resumed')).toBeUndefined()
})

test('the plan store is bounded', () => {
  const plans = createEffortPlans(4)
  for (let i = 0; i < 50; i++) plans.expect(hashKey(`p${i}`), 'low')
  for (let i = 0; i < 50; i++) plans.bind(`a${i}`, hashKey(`q${i}`), 'low')
  expect(plans.size() <= 8).toBe(true)
})

// --- main-loop decisions: tied to the prompt's text -----------------------------------------------

const deep: Decision = decide('deep', 0.99)
const fast: Decision = decide('fast', 0.99)

test('a decision goes to the turn that carries its prompt', () => {
  const pending = createPendingPrompts()
  pending.put('refactor the parser', deep)
  expect(pending.claim('refactor the parser')).toEqual(deep)
})

test('a prompt that never started a turn cannot shift the next one', () => {
  const pending = createPendingPrompts()
  // A command, a prompt a higher hook dropped: classified, never turned.
  pending.put('ghost prompt', fast)
  pending.put('the real prompt', deep)
  expect(pending.claim('the real prompt')).toEqual(deep)
  // The stale one was cleared with it.
  expect(pending.size()).toBe(0)
})

test('a turn for some other text gets no decision, and keeps the waiting one', () => {
  const pending = createPendingPrompts()
  pending.put('mine', deep)
  expect(pending.claim('something else')).toBeNull()
  expect(pending.claim('')).toBeNull()
  expect(pending.claim('mine')).toEqual(deep)
})

test('a merged turn finds its prompt only when exactly one fits', () => {
  const pending = createPendingPrompts()
  pending.put('first', fast)
  expect(pending.claim('first\n\nand more text')).toEqual(fast)

  pending.put('alpha', fast)
  pending.put('beta', deep)
  expect(pending.claim('alpha then beta')).toBeNull()
})

test('a decision is used once', () => {
  const pending = createPendingPrompts()
  pending.put('x', deep)
  pending.claim('x')
  expect(pending.claim('x')).toBeNull()
})

test('a failed classification is still tied to its prompt', () => {
  const pending = createPendingPrompts()
  pending.put('x', null)
  pending.put('y', deep)
  expect(pending.claim('y')).toEqual(deep)
})

test('the pending list is bounded', () => {
  const pending = createPendingPrompts(3)
  for (let i = 0; i < 20; i++) pending.put(`p${i}`, deep)
  expect(pending.size()).toBe(3)
})

// --- what is skipped without a call -------------------------------------------------------------------

const normal = { prompt: 'Investigate the flaky test', fork: false }

test('forks, teammates and resumes are skipped with no call', () => {
  expect(skipReason({ ...normal, fork: true })?.kind).toBe('fork')
  expect(skipReason({ ...normal, isTeammate: true })?.kind).toBe('teammate')
  expect(skipReason({ ...normal, resume: { agentId: 'a' } })?.kind).toBe('resume')
  expect(skipReason(normal)).toBeNull()
})

test('a workflow agent with a normal prompt is routed', () => {
  expect(skipReason({ ...normal, workflow: { runId: 'wf_1', agentIndex: 1 } })).toBeNull()
})

const MARKER = '(withheld: this workflow run does not share its script)'

test('the exact withheld-script marker is a placeholder, only inside a workflow', () => {
  const workflow = { runId: 'wf_1', agentIndex: 1 }
  expect(skipReason({ prompt: MARKER, fork: false, workflow })?.kind).toBe('placeholder')
  expect(skipReason({ prompt: `  ${MARKER}\n`, fork: false, workflow })?.kind).toBe('placeholder')
  expect(skipReason({ prompt: MARKER, fork: false })).toBeNull()
  expect(isHiddenScriptPlaceholder(workflow, '(withheld: this run does not share its script)')).toBe(true)
})

test('ordinary prompts are never placeholders', () => {
  const workflow = { runId: 'wf_1', agentIndex: 1 }
  for (const prompt of [
    '',
    'Reply with the single word PONG.',
    '[script hidden]',
    '[prompt hidden]',
    '[redacted]',
    '(withheld)',
    'Explain why (withheld: the script) is not shared',
    `Note: ${MARKER}`,
    'Run the assigned step of the workflow.',
  ]) {
    expect(isHiddenScriptPlaceholder(workflow, prompt)).toBe(false)
    expect(skipReason({ prompt, fork: false, workflow })).toBeNull()
  }
})

test('the same short prompt on any number of agents of one run is always routed', () => {
  for (let i = 1; i <= 10; i++) {
    expect(skipReason({ prompt: 'Reply with the single word PONG.', fork: false, workflow: { runId: 'wf_9', agentIndex: i } })).toBeNull()
  }
})

test('only a person\'s own prompts are classified on the main loop', () => {
  expect(fromPerson({ kind: 'composer' })).toBe(true)
  expect(fromPerson({ kind: 'bridge' })).toBe(true)
  expect(fromPerson({ kind: 'sdk' })).toBe(true)
  expect(fromPerson({ kind: 'task-notification' })).toBe(false)
  expect(fromPerson({ kind: 'unclassified' })).toBe(false)
  expect(fromPerson(undefined)).toBe(false)
})

// --- failure handling ---------------------------------------------------------------------------------------

test('statuses map to failure kinds, and only a rejected key is fatal', () => {
  expect(classifyStatus(401)).toEqual({ kind: 'auth', fatal: true })
  expect(classifyStatus(403).fatal).toBe(true)
  expect(classifyStatus(429)).toEqual({ kind: 'rate-limit', fatal: false })
  expect(classifyStatus(503)).toEqual({ kind: 'server', fatal: false })
  expect(classifyStatus(400)).toEqual({ kind: 'http', fatal: false })
})

test('the breaker stops calling after repeated failures and tries again after the cooldown', () => {
  const breaker = createBreaker(3, 1000, 5000)
  expect(breaker.allow(0)).toBe(true)
  breaker.failure(0)
  breaker.failure(10)
  expect(breaker.allow(20)).toBe(true)
  breaker.failure(30)
  expect(breaker.allow(40)).toBe(false)
  expect(breaker.allow(1029)).toBe(false)
  expect(breaker.allow(1030)).toBe(true)
  // The probe failing re-opens it at once.
  breaker.failure(1030)
  expect(breaker.allow(1031)).toBe(false)
})

test('a success resets the count, and a rejected key pauses for much longer', () => {
  const breaker = createBreaker(3, 1000, 5000)
  breaker.failure(0)
  breaker.failure(1)
  breaker.success()
  breaker.failure(2)
  expect(breaker.allow(3)).toBe(true)
  breaker.failure(10, true)
  expect(breaker.allow(4000)).toBe(false)
  expect(breaker.allow(5010)).toBe(true)
})

test('a failure is shown the first time, again at 5, 25 and 100, and quietly between', () => {
  const notifier = createNotifier()
  const shown: number[] = []
  for (let i = 1; i <= 120; i++) if (notifier.report('timeout').show) shown.push(i)
  expect(shown).toEqual([1, 5, 25, 100])
})

test('each failure kind counts on its own', () => {
  const notifier = createNotifier()
  expect(notifier.report('timeout').show).toBe(true)
  expect(notifier.report('auth').show).toBe(true)
  expect(notifier.report('timeout').show).toBe(false)
})

test('a missing key, bad options and a forced model are told exactly once', () => {
  const notifier = createNotifier()
  for (const kind of ['no-key', 'config', 'override']) {
    expect(notifier.report(kind).show).toBe(true)
    for (let i = 0; i < 30; i++) expect(notifier.report(kind).show).toBe(false)
  }
})

test('the failure line names the cause, the count and what the subagent runs on', () => {
  const c = resolveOptions({ typesafeApiKey: 'k' }).config
  expect(describeFailure('timeout', 1, c)).toBe(
    '[jev-model-router] Jev did not answer within 1500ms: subagents run on the fallback opus/medium',
  )
  expect(describeFailure('auth', 5, c)).toContain('(5 so far)')
  expect(describeFailure('malformed', 1, c, 'main')).toContain('the main loop runs unchanged')
  expect(describeFailure('no-key', 1, c)).toContain('no TypeSafe or Gateway API key')
})

test('no failure line ever carries a key', () => {
  const c = resolveOptions({ typesafeApiKey: 'sekrit-key-value' }).config
  for (const kind of ['timeout', 'auth', 'rate-limit', 'server', 'http', 'malformed', 'network', 'circuit-open', 'no-key', 'classifier', 'config', 'override']) {
    expect(describeFailure(kind, 1, c)).not.toContain('sekrit')
  }
  expect(describeSetup(c)).not.toContain('sekrit')
})

// --- cache and keys ---------------------------------------------------------------------------------------------------

test('identical spawns hash alike and different ones do not', () => {
  expect(hashKey('Explore', 'find x', 'prompt')).toBe(hashKey('Explore', 'find x', 'prompt'))
  expect(hashKey('Explore', 'find x', 'prompt')).not.toBe(hashKey('Explore', 'find y', 'prompt'))
  expect(hashKey('ab', 'c')).not.toBe(hashKey('a', 'bc'))
})

test('the decision cache returns what was stored and is bounded', () => {
  const cache = createDecisionCache(3)
  const decision = decide('fast', 0.9)
  cache.set('k', decision)
  expect(cache.get('k')).toEqual(decision)
  expect(cache.get('missing')).toBeUndefined()
  for (let i = 0; i < 10; i++) cache.set(`k${i}`, decision)
  expect(cache.size()).toBe(3)
})

// --- what leaves the machine ------------------------------------------------------------------------------------------------

const ghToken = 'ghp_' + 'A1b2'.repeat(9)

test('the state sent for a subagent is redacted, then cut, field by field', () => {
  const { state, counts } = buildSubagentState(
    {
      prompt: `use ${ghToken} then ` + 'z'.repeat(9000),
      description: `desc ${ghToken}`,
      subagentType: 'Explore',
    },
    { redact: DEFAULT_REDACT, maxPromptChars: 4000 },
  )
  expect(JSON.stringify(state)).not.toContain('ghp_')
  expect(state.prompt?.startsWith('use [REDACTED:github-token] then')).toBe(true)
  expect((state.prompt ?? '').length < 4100).toBe(true)
  expect(state.description).toBe('desc [REDACTED:github-token]')
  expect(state.agentType).toBe('Explore')
  expect(counts['github-token']).toBe(2)
})

test('the prompt is cut to the configured size', () => {
  const { state } = buildSubagentState(
    { prompt: 'a b '.repeat(2000), description: 'd', subagentType: 't' },
    { redact: DEFAULT_REDACT, maxPromptChars: 300 },
  )
  expect((state.prompt ?? '').length < 330).toBe(true)
  expect(state.prompt).toContain('…[+')
})

test('with redaction off the text is sent as written, but still cut', () => {
  const { state, counts } = buildSubagentState(
    { prompt: `use ${ghToken}`, description: 'd', subagentType: 't' },
    { redact: { ...DEFAULT_REDACT, enabled: false }, maxPromptChars: 4000 },
  )
  expect(state.prompt).toContain('ghp_')
  expect(Object.keys(counts).length).toBe(0)
})

test('a typed prompt gets the same treatment as a subagent prompt', () => {
  const { state } = buildPromptState(`token ${ghToken}`, { redact: DEFAULT_REDACT, maxPromptChars: 4000 })
  expect(state.prompt).toBe('token [REDACTED:github-token]')
})

// --- review fixes ---------------------------------------------------------------

test('a scope-prefixed once-only class is shown exactly once', () => {
  const notifier = createNotifier()
  for (const kind of ['subagent:no-key', 'main:no-key']) {
    expect(notifier.report(kind).show).toBe(true)
    for (let i = 0; i < 200; i++) expect(notifier.report(kind).show).toBe(false)
  }
  // Prefixed escalating classes still escalate.
  const shown: number[] = []
  for (let i = 1; i <= 30; i++) if (notifier.report('subagent:timeout').show) shown.push(i)
  expect(shown).toEqual([1, 5, 25])
})

test('risk never moves the main-loop model down', () => {
  const lowDeep: PolicyConfig = { ...config, tiers: { fast: 'haiku', balanced: 'sonnet', deep: 'sonnet' } }
  const routing = route(decide('fast', 0.9, 0.5, 0.9, 0.95), { model: 'claude-opus-5-5', effort: 'high' }, lowDeep)
  expect(routing.model).toBeNull()
  // Up still works.
  const up = route(decide('fast', 0.9, 0.5, 0.9, 0.95), { model: 'claude-haiku-5-5', effort: 'high' }, lowDeep)
  expect(up.model).toBe('sonnet')
})

test('bind does not take the entry of another spawn with the same prompt', () => {
  const plans = createEffortPlans()
  const key = hashKey('same prompt')
  plans.expect(key, 'high')
  plans.expect(key, 'high')
  plans.claim('a', key) // A's turn.start
  plans.bind('a', key, 'high') // A's spawn returns
  expect(plans.effortOf('a')).toBe('high')
  plans.claim('b', key) // B's turn.start finds its own entry
  expect(plans.effortOf('b')).toBe('high')
  expect(plans.size()).toBe(2)
})

// --- second review round: a skipped spawn cannot take a routed spawn's effort ------

test('an unrouted agent with the same prompt takes its own entry, not the routed one', () => {
  const plans = createEffortPlans()
  const key = hashKey('same prompt')
  plans.expect(key, null) // skipped spawn, first
  plans.expect(key, 'high') // routed spawn
  plans.claim('skipped', key)
  plans.claim('routed', key)
  expect(plans.effortOf('skipped')).toBeUndefined()
  expect(plans.effortOf('routed')).toBe('high')
})

test('binding removes the matching entry even when the agent id arrives late', () => {
  const plans = createEffortPlans()
  const key = hashKey('p')
  plans.expect(key, null)
  plans.expect(key, 'low')
  plans.bind('a', key, null)
  plans.bind('b', key, 'low')
  expect(plans.effortOf('a')).toBeUndefined()
  expect(plans.effortOf('b')).toBe('low')
  expect(plans.size()).toBe(2)
})

// --- effort plans: spawns that never get an agent id ----------------------------------------

test('a spawn that settles without an agent id removes its own entry', () => {
  const plans = createEffortPlans()
  const key = hashKey('same prompt')
  const stale = plans.expect(key, 'xhigh', 1000)
  // next() settled with no agentId: the launcher cancels its own ticket.
  plans.cancel(key, 'xhigh', stale)
  expect(plans.size()).toBe(0)
  // A later spawn with the same prompt does not inherit it.
  const own = plans.expect(key, null, 2000)
  plans.claim('later', key, 2000)
  expect(plans.effortOf('later')).toBeUndefined()
  expect(plans.size()).toBe(1)
  void own
})

test('cancelling by ticket never removes another spawn\'s entry of the same effort', () => {
  const plans = createEffortPlans()
  const key = hashKey('p')
  const first = plans.expect(key, 'low', 1)
  const second = plans.expect(key, 'low', 2)
  plans.claim('a', key, 3) // a took the first entry at turn.start
  plans.cancel(key, 'low', first) // first spawn settles with no id: its entry is gone already
  plans.claim('b', key, 4)
  expect(plans.effortOf('b')).toBe('low')
  void second
})

test('an unclaimed entry expires after the ttl, a fresh one does not', () => {
  const plans = createEffortPlans(256, 60_000)
  const key = hashKey('p')
  plans.expect(key, 'xhigh', 0 + 1)
  plans.expect(hashKey('other'), 'low', 30_000)
  plans.claim('late', key, 61_002)
  expect(plans.effortOf('late')).toBeUndefined()
  plans.claim('x', hashKey('other'), 61_002)
  expect(plans.effortOf('x')).toBe('low')
})
