/**
 * The state file a status line reads: which routed subagents are running now,
 * and on what model and effort.
 *
 * Pure bookkeeping (no `$`): the hook feeds it events and writes what
 * `serialize` returns. File, per session:
 *
 *   <CLAUDE_CONFIG_DIR or $HOME/.claude>/state/jev-model-router/<sessionId>.json
 *   {"v":1,"sessionId":"…","updatedAt":<ms>,
 *    "active":[{"agentId":"…","model":"haiku|sonnet|opus|<raw>",
 *               "effort":"low|medium|high|xhigh"|null,"fallback":false,"startedAt":<ms>}]}
 *
 * `active` holds only agents THIS router routed (forks, teammates, resumes of
 * agents it never routed are not counted) that are running now. `model` is the
 * one the agent actually runs on (the spawn result's), not the requested one.
 */

export const SCHEMA_VERSION = 1
/** The file is rewritten at least this often while anything is active. */
export const HEARTBEAT_MS = 5000
/** An agent with no turn.start/turn.step for this long is no longer running. */
export const IDLE_PRUNE_MS = 20 * 60 * 1000
/** Routing metadata is forgotten after this long (a resume keeps it until then). */
export const META_TTL_MS = 4 * 60 * 60 * 1000

export interface AgentMeta {
  /** The family it runs on: haiku, sonnet, opus, or the raw lowercased id. */
  model: string
  effort: string | null
  fallback: boolean
}

export interface ActiveAgent extends AgentMeta {
  agentId: string
  startedAt: number
}

/** A session id safe to use as a file name; anything else is not written. */
export function safeSessionId(id: unknown): string | null {
  return typeof id === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(id) ? id : null
}

/** The state file's path under a config dir. */
export function statePath(configDir: string, sessionId: string): string {
  return `${configDir.replace(/\/+$/, '')}/state/jev-model-router/${sessionId}.json`
}

/** haiku | sonnet | opus by substring of the full model id; unknown stays raw. */
export function familyOf(model: string): string {
  const lowered = String(model).toLowerCase()
  for (const family of ['haiku', 'sonnet', 'opus']) if (lowered.includes(family)) return family
  return lowered
}

export function serialize(sessionId: string, now: number, active: ActiveAgent[]): string {
  const sorted = [...active].sort((a, b) => a.startedAt - b.startedAt || a.agentId.localeCompare(b.agentId))
  return JSON.stringify({
    v: SCHEMA_VERSION,
    sessionId,
    updatedAt: now,
    active: sorted.map((a) => ({
      agentId: a.agentId,
      model: a.model,
      effort: a.effort,
      fallback: a.fallback,
      startedAt: a.startedAt,
    })),
  })
}

/** Terminal statuses of `$.agent.list()` entries. */
const DONE = new Set(['completed', 'failed', 'killed'])

export interface Tracker {
  /** Records how an agent was routed (after `next()` returned its id). True if the active set changed. */
  bind(agentId: string, meta: AgentMeta, now: number): boolean
  /** The agent's loop started. True if the active set changed. */
  start(agentId: string, now: number): boolean
  /** The agent's loop ended, whatever the reason. True if the active set changed. */
  complete(agentId: string): boolean
  /** A step: refreshes liveness; re-adds a routed agent whose turn.start was missed. */
  step(agentId: string, now: number): boolean
  /** Whether a step of this agent is worth a clock read. */
  knows(agentId: string): boolean
  /** Drops idle agents, expired metadata and (given the engine's listing) finished agents. */
  prune(now: number, listed?: ReadonlyMap<string, string>): boolean
  /** Forgets everything. True if the active set changed. */
  reset(): boolean
  active(): ActiveAgent[]
  size(): number
}

export function createTracker(): Tracker {
  const meta = new Map<string, AgentMeta & { boundAt: number }>()
  const running = new Map<string, { startedAt: number; lastSeen: number }>()

  const isActive = (id: string) => meta.has(id) && running.has(id)

  return {
    bind(agentId, m, now) {
      const was = isActive(agentId)
      meta.set(agentId, { ...m, boundAt: now })
      return !was && isActive(agentId)
    },
    start(agentId, now) {
      const was = isActive(agentId)
      running.set(agentId, { startedAt: now, lastSeen: now })
      return !was && isActive(agentId)
    },
    complete(agentId) {
      const was = isActive(agentId)
      running.delete(agentId)
      return was
    },
    step(agentId, now) {
      const r = running.get(agentId)
      if (r) {
        r.lastSeen = now
        return false
      }
      if (!meta.has(agentId)) return false
      running.set(agentId, { startedAt: now, lastSeen: now })
      return true
    },
    knows(agentId) {
      return meta.has(agentId) || running.has(agentId)
    },
    prune(now, listed) {
      let changed = false
      for (const [id, r] of [...running]) {
        const status = listed?.get(id)
        if (now - r.lastSeen > IDLE_PRUNE_MS || (status !== undefined && DONE.has(status))) {
          if (isActive(id)) changed = true
          running.delete(id)
        }
      }
      for (const [id, m] of [...meta]) {
        if (!running.has(id) && now - m.boundAt > META_TTL_MS) meta.delete(id)
      }
      return changed
    },
    reset() {
      const was = this.size() > 0
      meta.clear()
      running.clear()
      return was
    },
    active() {
      const out: ActiveAgent[] = []
      for (const [agentId, r] of running) {
        const m = meta.get(agentId)
        if (m) out.push({ agentId, model: m.model, effort: m.effort, fallback: m.fallback, startedAt: r.startedAt })
      }
      return out
    },
    size() {
      let n = 0
      for (const id of running.keys()) if (meta.has(id)) n += 1
      return n
    },
  }
}

/**
 * Coalescing writer: one write in flight; requests that arrive meanwhile
 * collapse into one more write of the then-current state (the latest `write`
 * given runs). Every caller's promise settles when the run that covers its
 * request has finished.
 */
export function createCoalescer(): (write: () => Promise<void>) => Promise<void> {
  let run: Promise<void> | null = null
  let dirty = false
  let current: () => Promise<void> = async () => {}
  return (write) => {
    dirty = true
    current = write
    if (run) return run
    run = (async () => {
      try {
        while (dirty) {
          dirty = false
          try {
            await current()
          } catch {
            // The write reports its own failures; the loop goes on.
          }
        }
      } finally {
        run = null
      }
    })()
    return run
  }
}
