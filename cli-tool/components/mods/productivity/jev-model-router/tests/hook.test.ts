import { expect, mock, test } from 'claude-code/testing'

// Engine-driven tests: the real hooks of hooks/jev-model-router.ts run over the
// test's own bottom hooks, which stand for the engine and the network.

const KEY = 'test-' + 'key-not-real'
const jev = (tier: string, effort: number, confidence = 0.95, risky = 0.01) =>
  JSON.stringify({
    answers: {
      tier: { choice: tier, confidence },
      effort: { score: effort, confidence: 0.9 },
      risky: { noul: risky },
    },
  })

let seq = 0
const spawnInput = (over: Record<string, unknown> = {}) => ({
  tool_use_id: `tu${++seq}`,
  prompt: `Refactor module number ${seq} so that it logs less`,
  description: 'refactor',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  model: 'sonnet',
  parentModel: 'claude-opus-5-5[1m]',
  background: false,
  fork: false,
  ...over,
})

/** Bottom hooks that record the network, the UI and the spawns. */
function world(on: any, reply: (url: string) => { status: number; text: string } | 'hang' = () => ({ status: 200, text: jev('fast', 0.2) })) {
  const w = {
    fetches: [] as { url: string; body: string; auth: string }[],
    classifies: 0,
    toasts: [] as string[],
    logs: [] as string[],
    statuses: [] as (string | undefined)[],
    spawned: [] as { model?: string; prompt: string }[],
    steps: [] as { agentId?: string; effort?: unknown }[],
  }
  on('http.fetch', async ($: any, e: any) => {
    w.fetches.push({ url: e.url, body: String(e.init?.body ?? ''), auth: String(e.init?.headers?.Authorization ?? e.init?.headers?.authorization ?? '') })
    const r = reply(e.url)
    if (r === 'hang') return await new Promise(() => {})
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: r.text } }
  })
  on('model.classify', async () => {
    w.classifies += 1
    return { value: 'fast' }
  })
  on('ui.toast', async ($: any, e: any) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', async ($: any, e: any) => (w.logs.push(e.text), { value: undefined }))
  on('ui.status', async ($: any, e: any) => (w.statuses.push(e.text), { value: undefined }))
  let n = 0
  on('agent.spawn', async ($: any, e: any) => {
    w.spawned.push({ model: e.model, prompt: e.prompt })
    n += 1
    return { model: e.model ?? 'sonnet', agentId: `ag${n}` }
  })
  on('turn.step', async function* ($: any, e: any) {
    w.steps.push({ agentId: e.agentId, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  on('turn.complete', async () => ({ text: '' }))
  return w
}

const step = async ($: any, agentId: string | undefined, effort: string | undefined = 'medium') => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort, messageCount: 3, agentId })) void _
}

test('routing off by default: a typed prompt makes no network or classifier call', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'please delete the production database', wait: false })
  expect(w.fetches.length).toBe(0)
  expect(w.classifies).toBe(0)
})

test('a subagent spawn overrides the caller model with Jev\'s tier and binds its effort', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, () => ({ status: 200, text: jev('deep', 2.2) }))
  mock.clock(on)
  const r = await $.agent.spawn(spawnInput({ model: 'sonnet' }))
  expect(w.fetches.length).toBe(1)
  expect(w.spawned[0]?.model).toBe('opus')
  expect(r.agentId).toBe('ag1')
  await step($, 'ag1', 'medium')
  expect(w.steps.at(-1)?.effort).toBe('high')
  // The key travels only in the Authorization header.
  expect(w.fetches[0]?.auth).toContain(KEY)
  expect(w.fetches[0]?.body).not.toContain(KEY)
  expect(w.logs.join('\n')).not.toContain(KEY)
  expect(w.toasts.join('\n')).not.toContain(KEY)
})

test('a cheap confident decision names haiku explicitly even when the parent is opus[1m]', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, () => ({ status: 200, text: jev('fast', 0.1) }))
  mock.clock(on)
  await $.agent.spawn(spawnInput({ model: undefined }))
  expect(w.spawned[0]?.model).toBe('haiku')
})

test('effort is dropped when the agent ends', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, () => ({ status: 200, text: jev('balanced', 2.9) }))
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await step($, 'ag1', 'low')
  expect(w.steps.at(-1)?.effort).toBe('xhigh')
  await $.turn.complete({ turnId: 't1', agentId: 'ag1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  await step($, 'ag1', 'low')
  expect(w.steps.at(-1)?.effort).toBe('low')
})

test('an HTTP error runs the subagent on the fallback and tells the person', { options: { typesafeApiKey: KEY, fallbackModel: 'sonnet', fallbackEffort: 'high' } }, async ($, on) => {
  const w = world(on, () => ({ status: 500, text: 'boom' }))
  mock.clock(on)
  await $.agent.spawn(spawnInput({ model: 'haiku' }))
  expect(w.spawned[0]?.model).toBe('sonnet')
  await step($, 'ag1', 'low')
  expect(w.steps.at(-1)?.effort).toBe('high')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('server error')
  expect(w.toasts[0]).toContain('sonnet/high')
})

test('malformed JSON and a missing key in the answer are failures too', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  let answer = 'not json'
  const w = world(on, () => ({ status: 200, text: answer }))
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  answer = JSON.stringify({ answers: { effort: { score: 1 } } })
  await $.agent.spawn(spawnInput())
  expect(w.spawned.map((s) => s.model)).toEqual(['opus', 'opus'])
  expect(w.toasts.length).toBe(1) // one toast for the class, the second is counted
})

test('a Jev timeout falls back, loudly', { options: { typesafeApiKey: KEY, timeoutMs: 500 } }, async ($, on) => {
  const w = world(on, () => 'hang')
  const clock = mock.clock(on)
  const spawning = $.agent.spawn(spawnInput())
  await clock.advance(600)
  await spawning
  expect(w.spawned[0]?.model).toBe('opus')
  expect(w.toasts.some((t) => t.includes('did not answer within 500ms'))).toBe(true)
})

test('keyless: no Jev call, no classifier call, fallback applied, ONE notice', { options: {} }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  for (let i = 0; i < 30; i++) await $.agent.spawn(spawnInput())
  expect(w.fetches.length).toBe(0)
  expect(w.classifies).toBe(0)
  expect(w.spawned.every((s) => s.model === 'opus')).toBe(true)
  const notices = w.toasts.filter((t) => t.includes('no TypeSafe or Gateway API key'))
  expect(notices.length).toBe(1)
  expect(w.logs.filter((t) => t.includes('no TypeSafe or Gateway API key')).length).toBe(1)
  await step($, 'ag30', 'low')
  expect(w.steps.at(-1)?.effort).toBe('medium')
})

test('resumes, forks and teammates make no call and are left alone', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.agent.spawn(spawnInput({ resume: { agentId: 'old' }, model: 'haiku' }))
  await $.agent.spawn(spawnInput({ fork: true }))
  await $.agent.spawn(spawnInput({ isTeammate: true, name: 'scout' }))
  expect(w.fetches.length).toBe(0)
  expect(w.spawned[0]?.model).toBe('haiku')
})

test('a hidden-script workflow placeholder prompt makes no call', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.agent.spawn(spawnInput({ prompt: '[prompt hidden]', workflow: { runId: 'wf_1', agentIndex: 1 } }))
  expect(w.fetches.length).toBe(0)
})

test('a secret in the prompt never reaches the network', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  const secret = 'ghp_' + 'A1b2'.repeat(9)
  await $.agent.spawn(spawnInput({ prompt: `deploy with token ${secret} and password=hunter2 to prod` }))
  expect(w.fetches[0]?.body).not.toContain(secret)
  expect(w.fetches[0]?.body).not.toContain('hunter2')
  expect(w.fetches[0]?.body).toContain('[REDACTED:github-token]')
})

test('identical spawns in a session are decided once', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  const same = spawnInput()
  await $.agent.spawn(same)
  await $.agent.spawn({ ...same, tool_use_id: 'other' })
  expect(w.fetches.length).toBe(1)
})

test('main-loop routing on: only the person\'s own prompt is sent; keyless gets one notice', { options: { routeMainEffort: true } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: `do thing ${i} please`, wait: false, origin: { kind: 'composer' } } as any)
  await $.prompt.submit({ text: 'from a schedule', wait: false, origin: { kind: 'schedule' } } as any)
  expect(w.fetches.length).toBe(0)
  expect(w.classifies).toBe(0)
  expect(w.toasts.filter((t) => t.includes('no TypeSafe or Gateway API key')).length).toBe(1)
})

test('main-loop routing on with a key: a non-person origin and a bare command are not sent', { options: { routeMainEffort: true, typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  on('prompt.submit', async ($: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'from a schedule', wait: false, origin: { kind: 'schedule' } } as any)
  await $.prompt.submit({ text: '/simplify', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.fetches.length).toBe(0)
  await $.prompt.submit({ text: 'rename the variable foo to bar', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.fetches.length).toBe(1)
})
