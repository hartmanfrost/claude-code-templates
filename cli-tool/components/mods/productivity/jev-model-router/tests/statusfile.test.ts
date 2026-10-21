import { expect, mock, test } from 'claude-code/testing'
import {
  HEARTBEAT_MS,
  IDLE_PRUNE_MS,
  UNBOUND_GRACE_MS,
  META_TTL_MS,
  createCoalescer,
  createTracker,
  familyOf,
  safeSessionId,
  serialize,
  statePath,
} from '../hooks/statusfile.ts'

const meta = (model = 'haiku', effort: string | null = 'low', fallback = false) => ({ model, effort, fallback })

// ---- pure: tracker, serializer ------------------------------------------

test('familyOf never returns an empty model', () => {
  expect(familyOf('')).toBe('unknown')
})

test('familyOf matches by substring, keeps unknown ids raw', () => {
  expect(familyOf('claude-opus-5-5[1m]')).toBe('opus')
  expect(familyOf('Claude-Haiku-4')).toBe('haiku')
  expect(familyOf('sonnet')).toBe('sonnet')
  expect(familyOf('Some-Custom')).toBe('some-custom')
})

test('safeSessionId rejects traversal and odd ids', () => {
  expect(safeSessionId('174ed90d-8697-46d8-ba41-40780566076b')).toBe('174ed90d-8697-46d8-ba41-40780566076b')
  expect(safeSessionId('../x')).toBeNull()
  expect(safeSessionId('a/b')).toBeNull()
  expect(safeSessionId('')).toBeNull()
  expect(safeSessionId('a'.repeat(65))).toBeNull()
  expect(safeSessionId(undefined)).toBeNull()
})

test('statePath joins config dir, state dir and session id', () => {
  expect(statePath('/h/.claude', 'abc')).toBe('/h/.claude/state/jev-model-router/abc.json')
  expect(statePath('/h/.claude/', 'abc')).toBe('/h/.claude/state/jev-model-router/abc.json')
})

test('an agent is active only once it is both bound and running; either order works', () => {
  const t = createTracker()
  expect(t.bind('a', meta(), 1)).toBe(false) // routed but its loop has not started
  expect(t.size()).toBe(0)
  expect(t.start('a', 2)).toBe(true)
  expect(t.active()).toEqual([{ agentId: 'a', model: 'haiku', effort: 'low', fallback: false, startedAt: 2 }])
  // turn.start before the bind (it can arrive before next() returns)
  expect(t.start('b', 3)).toBe(false)
  expect(t.size()).toBe(1)
  expect(t.bind('b', meta('opus', 'high'), 4)).toBe(true)
  expect(t.size()).toBe(2)
})

test('an unrouted agent (no bind) is never counted', () => {
  const t = createTracker()
  expect(t.start('fork1', 1)).toBe(false)
  expect(t.step('fork1', 2)).toBe(false)
  expect(t.size()).toBe(0)
  expect(t.knows('fork1')).toBe(true) // running, but with no meta it never shows
  expect(t.active()).toEqual([])
})

test('complete removes in any reason; a resumed agent comes back with its old meta', () => {
  const t = createTracker()
  t.bind('a', meta('sonnet', 'medium'), 1)
  t.start('a', 2)
  expect(t.complete('a')).toBe(true)
  expect(t.complete('a')).toBe(false)
  expect(t.size()).toBe(0)
  expect(t.start('a', 50)).toBe(true) // resume
  expect(t.active()[0]).toMatchObject({ model: 'sonnet', effort: 'medium', startedAt: 50 })
})

test('step refreshes liveness without a change, and heals a missed turn.start', () => {
  const t = createTracker()
  t.bind('a', meta(), 0)
  expect(t.step('a', 5)).toBe(true) // never started: re-added
  expect(t.step('a', 6)).toBe(false) // already running: Map update only
  expect(t.step('zzz', 6)).toBe(false)
})

test('prune drops idle agents, finished ones from the listing, and old metadata', () => {
  const t = createTracker()
  for (const id of ['idle', 'done', 'live']) {
    t.bind(id, meta(), 0)
    t.start(id, 0)
  }
  t.step('live', IDLE_PRUNE_MS)
  const listed = new Map([['done', 'completed'], ['live', 'running']])
  expect(t.prune(IDLE_PRUNE_MS + 1, listed)).toBe(true)
  expect(t.active().map((a) => a.agentId)).toEqual(['live'])
  // metadata of a finished agent expires; a later start no longer counts
  t.complete('live')
  t.prune(IDLE_PRUNE_MS + 1 + META_TTL_MS + 1)
  t.start('live', 1)
  expect(t.size()).toBe(0)
  // a running agent is not pruned by the listing when it says running or lists nothing
  const u = createTracker()
  u.bind('x', meta(), 0)
  u.start('x', 0)
  expect(u.prune(10, new Map())).toBe(false)
  expect(u.prune(10, new Map([['x', 'running']]))).toBe(false)
})

test('a long-quiet agent that the engine lists as running or waiting is not idle-pruned', () => {
  const t = createTracker()
  for (const id of ['run', 'wait', 'unknown']) {
    t.bind(id, meta(), 0)
    t.start(id, 0)
  }
  const listed = new Map([['run', 'running'], ['wait', 'waiting']])
  expect(t.prune(IDLE_PRUNE_MS * 3, listed)).toBe(true)
  expect(t.active().map((a) => a.agentId).sort()).toEqual(['run', 'wait'])
})

test('a resume of a routed agent shows its effort as unknown, keeps model', () => {
  const t = createTracker()
  t.bind('a', meta('opus', 'high'), 0)
  t.start('a', 1)
  t.complete('a')
  expect(t.resumed('a')).toBe(false) // not running yet: nothing visible changed
  expect(t.start('a', 5)).toBe(true)
  expect(t.active()[0]).toMatchObject({ model: 'opus', effort: null })
  // resumed while already running reports the change
  const u = createTracker()
  u.bind('b', meta('opus', 'high'), 0)
  u.start('b', 1)
  expect(u.resumed('b')).toBe(true)
  expect(u.resumed('b')).toBe(false)
  expect(u.resumed('nobody')).toBe(false)
})

test('unrouted agents and old metadata are swept without any heartbeat', () => {
  const t = createTracker()
  t.start('fork', 0)
  t.start('other', UNBOUND_GRACE_MS + 1) // any later event sweeps
  expect(t.knows('fork')).toBe(false)
  expect(t.knows('other')).toBe(true)
  t.bind('r', meta(), 0)
  t.start('r', 0)
  t.complete('r')
  t.start('late', META_TTL_MS + 1)
  expect(t.knows('r')).toBe(false)
})

test('reset empties and reports a change only when there was one', () => {
  const t = createTracker()
  expect(t.reset()).toBe(false)
  t.bind('a', meta(), 0)
  t.start('a', 0)
  expect(t.reset()).toBe(true)
  expect(t.size()).toBe(0)
})

test('serialize writes the v1 schema, sorted by start time', () => {
  const text = serialize('sid', 1000, [
    { agentId: 'b', model: 'opus', effort: 'high', fallback: true, startedAt: 20 },
    { agentId: 'a', model: 'haiku', effort: null, fallback: false, startedAt: 10 },
  ])
  expect(JSON.parse(text)).toEqual({
    v: 1,
    sessionId: 'sid',
    updatedAt: 1000,
    active: [
      { agentId: 'a', model: 'haiku', effort: null, fallback: false, startedAt: 10 },
      { agentId: 'b', model: 'opus', effort: 'high', fallback: true, startedAt: 20 },
    ],
  })
  expect(JSON.parse(serialize('sid', 1, [])).active).toEqual([])
  expect(text.length).toBeLessThan(1024)
})

test('the coalescer runs one write at a time and collapses a burst into two', async () => {
  let writes = 0
  let inflight = 0
  let maxInflight = 0
  let release: () => void = () => {}
  const gate = () => new Promise<void>((r) => (release = r))
  const request = createCoalescer()
  const write = async () => {
    writes += 1
    inflight += 1
    maxInflight = Math.max(maxInflight, inflight)
    if (writes === 1) await gate()
    inflight -= 1
  }
  const first = request(write)
  const burst = Array.from({ length: 10 }, () => request(write))
  await Promise.resolve()
  release()
  await Promise.all([first, ...burst])
  expect(writes).toBe(2)
  expect(maxInflight).toBe(1)
  await request(write)
  expect(writes).toBe(3)
})

test('the coalescer survives a failing write', async () => {
  let n = 0
  const request = createCoalescer()
  const write = async () => {
    n += 1
    throw new Error('disk full')
  }
  await request(write)
  await request(write)
  expect(n).toBe(2)
})

// ---- engine-driven: the hook writes the file ----------------------------

let seq = 0
const spawnInput = (over: Record<string, unknown> = {}) => ({
  tool_use_id: `tu${++seq}`,
  prompt: `Do task number ${seq}`,
  description: 'task',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  model: 'sonnet',
  parentModel: 'claude-opus-5-5[1m]',
  background: false,
  fork: false,
  ...over,
})

const KEY = 'test-' + 'key-not-real'
const jev = (tier: string, effort: number) =>
  JSON.stringify({ answers: { tier: { choice: tier, confidence: 0.95 }, effort: { score: effort, confidence: 0.9 }, risky: { noul: 0.01 } } })

function world(
  on: any,
  env: Record<string, string | undefined> = { HOME: '/home/me' },
  tiers: string[] = ['fast'],
  over: { fetch?: () => { status: number; text: string }; spawnModel?: string; agentId?: (n: number) => string; spawn?: (e: any, n: number) => Promise<void> } = {},
) {
  const w = { hang: false, writes: [] as { path: string; json: any }[], list: [] as { id: string; status: string }[] }
  on('env.get', ($: any, e: any) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', ($: any, e: any) => {
    if (w.hang) return new Promise(() => {}) as never
    w.writes.push({ path: e.path, json: JSON.parse(e.text) })
    return { value: undefined }
  })
  on('agent.list', () => ({ value: w.list }) as never)
  let call = 0
  on('http.fetch', async () => {
    const tier = tiers[Math.min(call, tiers.length - 1)]
    call += 1
    if (over.fetch) {
      const r = over.fetch()
      return { value: { status: r.status, ok: r.status < 300, headers: {}, text: r.text } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: jev(tier, tier === 'deep' ? 2.2 : 0.2) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  let n = 0
  on('agent.spawn', async ($: any, e: any) => {
    n += 1
    await over.spawn?.(e, n)
    return { model: over.spawnModel ?? e.model ?? 'sonnet', agentId: over.agentId?.(n) ?? `ag${n}` }
  })
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any
  })
  on('turn.start', async ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  return w
}

const start = (id: string) => ({ turnId: 'tt-' + id, text: 'x', agentId: id }) as any
const done = (id: string) => ({ turnId: 'tt-' + id, agentId: id, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }) as any
const flush = () => new Promise<void>((r) => setTimeout(r, 5))
const last = (w: ReturnType<typeof world>) => w.writes.at(-1)!.json

test('a routed subagent shows up at turn.start and leaves at turn.complete', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  expect(w.writes.length).toBe(0) // routed, not running yet
  await $.turn.start(start('ag1'))
  await flush()
  expect(w.writes.at(-1)!.path).toBe('/home/me/.claude/state/jev-model-router/sess-1.json')
  expect(last(w)).toMatchObject({ v: 1, sessionId: 'sess-1' })
  expect(last(w).active).toMatchObject([{ agentId: 'ag1', model: 'haiku', effort: 'low', fallback: false }])
  await $.turn.complete(done('ag1'))
  await flush()
  expect(last(w).active).toEqual([])
})

test('turn.start before the spawn returns is picked up at the bind', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, { HOME: '/home/me' }, ['fast'], { spawn: async () => void (await $.turn.start(start('ag1'))) })
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  expect(last(w).active.map((a: any) => a.agentId)).toEqual(['ag1'])
})

test('statusFile off writes nothing', { options: { typesafeApiKey: KEY, statusFile: false } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  await $.turn.complete(done('ag1'))
  await flush()
  expect(w.writes.length).toBe(0)
})

test('CLAUDE_CONFIG_DIR wins over HOME; no HOME and no config dir writes nothing', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, { CLAUDE_CONFIG_DIR: '/cfg/boosta', HOME: '/home/me' })
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  expect(w.writes.at(-1)!.path).toBe('/cfg/boosta/state/jev-model-router/sess-1.json')
})

test('no config dir and no HOME: nothing is written, nothing throws', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, {})
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  expect(w.writes.length).toBe(0)
})

test('the model is the one it runs on (override), and a fallback is flagged', { options: { typesafeApiKey: KEY, fallbackModel: 'sonnet', fallbackEffort: 'high' } }, async ($, on) => {
  const w = world(on, { HOME: '/home/me' }, ['fast'], { fetch: () => ({ status: 500, text: 'boom' }), spawnModel: 'claude-opus-5-5' })
  mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  expect(last(w).active).toMatchObject([{ model: 'opus', effort: 'high', fallback: true }])
})

test('forks and resumes (unrouted) are not counted', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.agent.spawn(spawnInput({ fork: true }))
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  expect(w.writes.length).toBe(0)
})

test('concurrent agents aggregate; steps do not write', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, { HOME: '/home/me' }, ['fast', 'deep', 'deep'])
  mock.clock(on)
  for (const id of ['ag1', 'ag2', 'ag3']) {
    await $.agent.spawn(spawnInput())
    await flush()
    await $.turn.start(start(id))
    await flush()
  }
  expect(last(w).active.map((a: any) => `${a.model}/${a.effort}`)).toEqual(['haiku/low', 'opus/high', 'opus/high'])
  const before = w.writes.length
  for (let i = 0; i < 5; i++) {
    for await (const _ of $.turn.step({ turnId: 't', index: i, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'ag2' } as any)) void _
  }
  expect(w.writes.length).toBe(before)
})

test('heartbeat rewrites while active, prunes finished agents, and stops when empty', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  const n = w.writes.length
  const t0 = last(w).updatedAt
  await clock.advance(HEARTBEAT_MS)
  expect(w.writes.length).toBeGreaterThan(n)
  expect(last(w).updatedAt).toBeGreaterThan(t0)
  expect(last(w).active.length).toBe(1)
  // the engine says it finished although no turn.complete arrived
  w.list = [{ id: 'ag1', status: 'killed' }]
  await clock.advance(HEARTBEAT_MS)
  expect(last(w).active).toEqual([])
  const m = w.writes.length
  await clock.advance(HEARTBEAT_MS * 3)
  expect(w.writes.length).toBe(m) // loop ended
})

test('session.end and session.start reset the file', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  mock.clock(on)
  on('session.end', async () => ({ sessionId: 'sess-1' }) as never)
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  await $.agent.spawn(spawnInput())
  await flush()
  await $.turn.start(start('ag1'))
  await flush()
  expect(last(w).active.length).toBe(1)
  await $.session.end({ reason: 'exit' } as never)
  await flush()
  expect(last(w).active).toEqual([])
})

test('a hung fs.write never holds up turn.start or the spawn result', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on)
  w.hang = true // fs.write never settles
  mock.clock(on)
  const spawned = await Promise.race([$.agent.spawn(spawnInput()).then(() => 'ok'), new Promise((r) => setTimeout(() => r('hung'), 500))])
  expect(spawned).toBe('ok')
  const started = await Promise.race([$.turn.start(start('ag1')).then(() => 'ok'), new Promise((r) => setTimeout(() => r('hung'), 500))])
  expect(started).toBe('ok')
})

test('a model the engine reports as nothing is written as "unknown", never empty', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world(on, { HOME: '/home/me' }, ['fast'], { spawnModel: '' })
  mock.clock(on)
  await $.agent.spawn(spawnInput({ model: undefined }))
  await $.turn.start(start('ag1'))
  await flush()
  expect(last(w).active.every((a: any) => a.model.length > 0)).toBe(true)
})

test('the written file keeps the contract shape byte for byte', () => {
  expect(serialize('s', 5, [{ agentId: 'a', model: 'opus', effort: null, fallback: false, startedAt: 1 }])).toBe(
    '{"v":1,"sessionId":"s","updatedAt":5,"active":[{"agentId":"a","model":"opus","effort":null,"fallback":false,"startedAt":1}]}',
  )
})
