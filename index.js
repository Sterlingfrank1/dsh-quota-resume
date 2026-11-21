/**
 * dsh-quota-resume — resume agent work that provider quota interrupted.
 *
 * Two recovery lanes:
 *  - `inline`: a short cooldown (Retry-After or a short backoff) is ridden out
 *    inside the same open turn, so the user never sees a break;
 *  - `park`: a window-shaped quota (5h / weekly / monthly) closes the turn and
 *    `dsh-schedule` wakes the same session with a continuation prompt at the
 *    estimated reset time. A failed continuation simply parks again with a
 *    longer probe delay, so the plugin converges on the real reset moment
 *    without knowing it in advance.
 *
 * The plugin is dependency-free on purpose: it only reads the public
 * `agent/request-error` payload and the optional `schedule` service through
 * `ctx.reflect.get`, so it resolves no @deepseek-ai package at runtime.
 *
 * @module dsh-quota-resume
 */

export const name = 'quota-resume'

/** The unmerged defaults, exported for tests and documentation. */
export { DEFAULTS }

/** Marker carried by every prompt this plugin schedules, used for de-duplication. */
export const PROMPT_MARKER = '[quota-resume]'

const QUOTA_CODES = new Set(['QUOTA'])
const BALANCE_CODES = new Set(['ACCOUNT_QUOTA'])
const RATE_CODES = new Set(['RATE_LIMIT'])

const DEFAULTS = Object.freeze({
  enabled: true,
  handleQuota: true,
  handleRateLimit: true,
  handleBalance: false,
  providers: [],
  exemptProviders: [],
  quotaRetries: 2,
  quotaBaseMs: 20_000,
  rateLimitRetries: 3,
  rateLimitBaseMs: 5_000,
  inlineMaxMs: 300_000,
  probeInitialMs: 600_000,
  probeMaxMs: 3_600_000,
  maxProbes: 0,
  probeJitterRatio: 0.1,
  fallbackDelayMs: 300_000,
  resumeTitle: '额度恢复后自动继续',
  resumePrompt: [
    `${PROMPT_MARKER} 上一次请求因额度限制被中断，现在已到预计恢复时间。`,
    '请先根据会话历史确认：被中断时正在执行哪一步、哪些工作已经完成、哪些工具调用可能没有结算。',
    '然后直接继续完成原任务：不要重做已经完成的工作，也不要重新询问已经确认过的信息。',
    '如果本次请求仍然失败，插件会自动安排下一次恢复尝试。',
    '如果原任务其实已经完成，只需用一句话说明，不要开始新的工作。',
  ].join('\n'),
})

const NUMERIC_KEYS = new Set([
  'quotaRetries',
  'quotaBaseMs',
  'rateLimitRetries',
  'rateLimitBaseMs',
  'inlineMaxMs',
  'probeInitialMs',
  'probeMaxMs',
  'maxProbes',
  'probeJitterRatio',
  'fallbackDelayMs',
])

/**
 * Merge one loader config row over the defaults, dropping unusable values.
 * @param {unknown} raw - the row's `config` object.
 * @returns {Readonly<typeof DEFAULTS>} normalized configuration.
 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze(config)
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== typeof fallback) continue
    if (NUMERIC_KEYS.has(key)) {
      if (!Number.isFinite(value)) continue
      if (typeof fallback === 'number' && fallback > 0 && (key !== 'maxProbes') && value < 0) continue
    }
    if (typeof value === 'string' && value.trim() === '') continue
    if (Array.isArray(value) && value.some(item => typeof item !== 'string')) continue
    config[key] = Array.isArray(value) ? [...value] : value
  }
  if (config.inlineMaxMs < 250) config.inlineMaxMs = 250
  if (config.probeMaxMs < config.probeInitialMs) config.probeMaxMs = config.probeInitialMs
  if (config.probeJitterRatio < 0) config.probeJitterRatio = 0
  if (config.probeJitterRatio > 0.5) config.probeJitterRatio = 0.5
  if (config.quotaRetries < 0) config.quotaRetries = 0
  if (config.rateLimitRetries < 0) config.rateLimitRetries = 0
  if (config.maxProbes < 0) config.maxProbes = 0
  return Object.freeze(config)
}

/** Whether this plugin should act on one provider route. */
function providerAllowed(config, provider) {
  if (config.exemptProviders.includes(provider)) return false
  return config.providers.length === 0 || config.providers.includes(provider)
}

function boundedDelay(value, max) {
  if (!Number.isFinite(value)) return max
  return Math.min(Math.max(Math.round(value), 250), max)
}

function probeDelay(config, probe, floorMs) {
  const exponential = config.probeInitialMs * 2 ** Math.min(probe, 16)
  const capped = Math.min(exponential, config.probeMaxMs)
  const jitter = 1 - config.probeJitterRatio + 2 * config.probeJitterRatio * Math.random()
  return Math.max(Math.round(capped * jitter), Math.min(floorMs, config.probeMaxMs))
}

/**
 * Decide what to do with one failed model request.
 *
 * @param {object} input
 * @param {string} input.code - provider-neutral failure code.
 * @param {string} input.provider - the route that failed.
 * @param {number} [input.providerRetryAfterMs] - upstream `Retry-After`, when known.
 * @param {number} [input.attempt] - inline attempts already made in this round.
 * @param {number} [input.probe] - parked probes already made in this round.
 * @param {Readonly<typeof DEFAULTS>} [input.config] - normalized configuration.
 * @returns {{kind: 'skip'}
 *   | {kind: 'balance', code: string}
 *   | {kind: 'inline', code: string, delayMs: number, attempt: number}
 *   | {kind: 'park', code: string, delayMs: number, probe: number}
 *   | {kind: 'exhausted', code: string, probe: number}}
 *   the recovery lane for this failure.
 */
export function decideQuotaAction({ code, provider, providerRetryAfterMs, attempt = 0, probe = 0, config = DEFAULTS }) {
  if (!config.enabled) return { kind: 'skip' }
  if (typeof code !== 'string' || code.length === 0) return { kind: 'skip' }
  if (!providerAllowed(config, provider)) return { kind: 'skip' }

  const hint = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0
    ? providerRetryAfterMs
    : undefined

  if (BALANCE_CODES.has(code)) {
    if (!config.handleBalance) return { kind: 'balance', code }
    return parkDecision({ code, probe, config, hint, floorMs: 0 })
  }

  if (RATE_CODES.has(code)) {
    if (!config.handleRateLimit) return { kind: 'skip' }
    if (attempt < config.rateLimitRetries) {
      const delayMs = boundedDelay(
        hint ?? config.rateLimitBaseMs * 2 ** Math.min(attempt, 16),
        config.inlineMaxMs,
      )
      if (hint === undefined || hint <= config.inlineMaxMs) {
        return { kind: 'inline', code, delayMs, attempt }
      }
    }
    return parkDecision({ code, probe, config, hint, floorMs: config.probeInitialMs })
  }

  if (QUOTA_CODES.has(code)) {
    if (!config.handleQuota) return { kind: 'skip' }
    if (attempt < config.quotaRetries) {
      const delayMs = boundedDelay(
        hint ?? config.quotaBaseMs * 2 ** Math.min(attempt, 16),
        config.inlineMaxMs,
      )
      if (hint === undefined || hint <= config.inlineMaxMs) {
        return { kind: 'inline', code, delayMs, attempt }
      }
    }
    return parkDecision({ code, probe, config, hint, floorMs: config.probeInitialMs })
  }

  return { kind: 'skip' }
}

function parkDecision({ code, probe, config, hint, floorMs }) {
  if (config.maxProbes > 0 && probe >= config.maxProbes) {
    return { kind: 'exhausted', code, probe }
  }
  const base = probeDelay(config, probe, floorMs)
  const delayMs = hint !== undefined ? Math.max(base, Math.round(hint)) : base
  return { kind: 'park', code, delayMs, probe }
}

/** A cancellable delay that resolves `false` when either signal aborts. */
function waitFor(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function roundKey(sessionId, provider) {
  return `${sessionId}\u0000${provider}`
}

/**
 * Install the quota recovery listener and its optional scheduled wake-ups.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} [rawConfig] - this row's configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const rounds = new Map()
  const parked = new Map()
  const lifetime = new AbortController()

  function roundOf(sessionId, provider) {
    const key = roundKey(sessionId, provider)
    let round = rounds.get(key)
    if (round === undefined) {
      round = { attempt: 0, probe: 0 }
      rounds.set(key, round)
    }
    return round
  }

  function resetRound(sessionId, provider) {
    if (provider === undefined) {
      for (const key of rounds.keys()) {
        if (key.startsWith(`${sessionId}\u0000`)) rounds.delete(key)
      }
      return
    }
    rounds.delete(roundKey(sessionId, provider))
  }

  async function findParkedTask(schedule, sessionId) {
    if (typeof schedule?.list !== 'function') return undefined
    const page = await schedule.list({ active: true, limit: 200 })
    const items = Array.isArray(page?.items) ? page.items : []
    return items.find(entry => entry?.target?.kind === 'session'
      && entry.target.sessionId === sessionId
      && typeof entry.prompt === 'string'
      && entry.prompt.startsWith(PROMPT_MARKER))
  }

  async function cancelParkedTask(schedule, sessionId) {
    const task = await findParkedTask(schedule, sessionId)
    if (task === undefined) return
    if (typeof schedule.edit === 'function') {
      await schedule.edit({ id: task.id, action: 'delete' }, sessionId)
    }
  }

  async function parkSession(agent, provider, code, delayMs) {
    const schedule = ctx.reflect.get('schedule')
    const sessionId = agent?.session?.id
    if (schedule === undefined || schedule === null) {
      return { parked: false, reason: 'schedule service is not mounted' }
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { parked: false, reason: 'agent has no session id' }
    }
    const at = new Date(Date.now() + Math.max(delayMs, 60_000)).toISOString()
    const timing = { kind: 'at', at }
    const title = config.resumeTitle.slice(0, 120)
    const prompt = `${config.resumePrompt}\n(provider=${provider} code=${code} retry_at=${at})`
    try {
      const existing = await findParkedTask(schedule, sessionId)
      if (existing !== undefined && typeof schedule.edit === 'function') {
        await schedule.edit({ id: existing.id, action: 'update', patch: { title, prompt, timing } }, sessionId)
        return { parked: true, taskId: existing.id, at }
      }
      const entry = await schedule.create({ title, prompt, timing, target: { kind: 'session', sessionId } }, sessionId)
      return { parked: true, taskId: entry?.id, at }
    } catch (error) {
      return { parked: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const dispose = ctx.on('agent/request-error', async (payload, next) => {
    if (lifetime.signal.aborted) return next()
    const { agent, provider, failure, signal } = payload ?? {}
    const code = failure?.code
    const sessionId = agent?.session?.id ?? 'unknown'
    const round = roundOf(sessionId, provider)
    const decision = decideQuotaAction({
      code,
      provider,
      providerRetryAfterMs: failure?.providerRetryAfterMs,
      attempt: round.attempt,
      probe: round.probe,
      config,
    })

    if (decision.kind === 'skip') return next()

    if (decision.kind === 'balance') {
      ctx.logger?.warn?.(
        'quota-resume: account balance exhausted for %s (%s); waiting cannot help — top up, then continue manually.',
        provider,
        code,
      )
      return next()
    }

    if (decision.kind === 'exhausted') {
      ctx.logger?.warn?.(
        'quota-resume: giving up after %d scheduled attempts for %s (%s).',
        decision.probe,
        provider,
        code,
      )
      return next()
    }

    if (decision.kind === 'park') {
      round.attempt = 0
      round.probe = decision.probe + 1
      const outcome = await parkSession(agent, provider, code, decision.delayMs)
      if (outcome.parked) {
        parked.set(sessionId, outcome.taskId)
        ctx.logger?.info?.(
          'quota-resume: %s hit %s on %s; paused and scheduled a continuation at %s.',
          sessionId,
          code,
          provider,
          outcome.at,
        )
        return next()
      }
      // No durable wake-up is available (for example a delegated child session):
      // ride out the quota in the same turn instead of losing the work.
      ctx.logger?.warn?.(
        'quota-resume: could not schedule a wake-up for %s (%s); retrying in %d ms inside the turn.',
        sessionId,
        outcome.reason,
        config.fallbackDelayMs,
      )
      const alive = await waitFor(config.fallbackDelayMs, fuseSignals(signal, lifetime.signal))
      if (!alive) return next()
      round.probe += 1
      return { kind: 'retry' }
    }

    const alive = await waitFor(decision.delayMs, fuseSignals(signal, lifetime.signal))
    if (!alive) return next()
    round.attempt = decision.attempt + 1
    ctx.logger?.info?.(
      'quota-resume: %s retrying %s after %s in %d ms.',
      sessionId,
      code,
      provider,
      decision.delayMs,
    )
    return { kind: 'retry' }
  })

  const disposeSuccess = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    resetRound(sessionId)
    if (!parked.has(sessionId)) return
    parked.delete(sessionId)
    const schedule = ctx.reflect.get('schedule')
    if (schedule === undefined || schedule === null) return
    void cancelParkedTask(schedule, sessionId).catch((error) => {
      ctx.logger?.warn?.('quota-resume: stale wake-up cleanup failed: %s', String(error))
    })
  })

  ctx.effect(() => async () => {
    dispose()
    disposeSuccess()
    lifetime.abort(new Error('quota-resume disposed'))
  }, 'quota-resume: stop pending recovery waits')
}

function fuseSignals(signal, lifetime) {
  if (signal === undefined || signal === null) return lifetime
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, lifetime])
  return signal
}
