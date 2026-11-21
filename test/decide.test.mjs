import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, decideQuotaAction, normalizeConfig } from '../index.js'

const config = normalizeConfig({})

test('non-quota failures are left alone', () => {
  for (const code of ['TIMEOUT', 'SERVER', 'AUTH', 'CONTEXT_WINDOW_EXCEEDED']) {
    assert.deepEqual(decideQuotaAction({ code, provider: 'dsh-opencode-go', config }), { kind: 'skip' })
  }
})

test('a disabled plugin never acts', () => {
  const off = normalizeConfig({ enabled: false })
  assert.deepEqual(
    decideQuotaAction({ code: 'QUOTA', provider: 'p', config: off }),
    { kind: 'skip' },
  )
})

test('provider allow and deny lists gate recovery', () => {
  const only = normalizeConfig({ providers: ['dsh-opencode-go'] })
  assert.equal(decideQuotaAction({ code: 'QUOTA', provider: 'dsh-opencode-go', config: only }).kind, 'inline')
  assert.equal(decideQuotaAction({ code: 'QUOTA', provider: 'deepseek', config: only }).kind, 'skip')

  const exempt = normalizeConfig({ exemptProviders: ['deepseek'] })
  assert.equal(decideQuotaAction({ code: 'QUOTA', provider: 'deepseek', config: exempt }).kind, 'skip')
})

test('QUOTA rides short backoff inside the turn, then parks', () => {
  const first = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 0, config })
  assert.equal(first.kind, 'inline')
  assert.equal(first.delayMs, 20_000)

  const second = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 1, config })
  assert.equal(second.kind, 'inline')
  assert.equal(second.delayMs, 40_000)

  const third = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 2, probe: 0, config })
  assert.equal(third.kind, 'park')
  assert.ok(third.delayMs >= 540_000 && third.delayMs <= 660_000, `probe delay ${third.delayMs}`)
})

test('a provider Retry-After beyond the inline ceiling parks at that moment', () => {
  const decision = decideQuotaAction({
    code: 'QUOTA',
    provider: 'p',
    attempt: 0,
    probe: 0,
    providerRetryAfterMs: 3 * 60 * 60 * 1000,
    config,
  })
  assert.equal(decision.kind, 'park')
  assert.equal(decision.delayMs, 3 * 60 * 60 * 1000)
})

test('a short Retry-After is honoured inline', () => {
  const decision = decideQuotaAction({
    code: 'RATE_LIMIT',
    provider: 'p',
    attempt: 0,
    providerRetryAfterMs: 7_000,
    config,
  })
  assert.equal(decision.kind, 'inline')
  assert.equal(decision.delayMs, 7_000)
})

test('repeated parks escalate and eventually exhaust the probe budget', () => {
  const capped = normalizeConfig({ maxProbes: 2, probeJitterRatio: 0 })
  const first = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 2, probe: 0, config: capped })
  assert.equal(first.kind, 'park')
  assert.equal(first.delayMs, 600_000)

  const second = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 2, probe: 1, config: capped })
  assert.equal(second.kind, 'park')
  assert.equal(second.delayMs, 1_200_000)

  const third = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 2, probe: 2, config: capped })
  assert.deepEqual(third, { kind: 'exhausted', code: 'QUOTA', probe: 2 })
})

test('probe delays never exceed the configured ceiling', () => {
  const clamped = normalizeConfig({ probeJitterRatio: 0, probeMaxMs: 1_200_000 })
  const decision = decideQuotaAction({ code: 'QUOTA', provider: 'p', attempt: 9, probe: 9, config: clamped })
  assert.equal(decision.kind, 'park')
  assert.equal(decision.delayMs, 1_200_000)
})

test('an exhausted balance is reported, not retried', () => {
  assert.deepEqual(
    decideQuotaAction({ code: 'ACCOUNT_QUOTA', provider: 'p', config }),
    { kind: 'balance', code: 'ACCOUNT_QUOTA' },
  )
  const opted = normalizeConfig({ handleBalance: true })
  assert.equal(decideQuotaAction({ code: 'ACCOUNT_QUOTA', provider: 'p', config: opted }).kind, 'park')
})

test('normalizeConfig rejects malformed values and keeps defaults', () => {
  const merged = normalizeConfig({
    enabled: 'yes',
    quotaRetries: Number.NaN,
    quotaBaseMs: '30000',
    inlineMaxMs: 10,
    providers: ['ok', 7],
    resumePrompt: '   ',
  })
  assert.equal(merged.enabled, true)
  assert.equal(merged.quotaRetries, config.quotaRetries)
  assert.equal(merged.quotaBaseMs, config.quotaBaseMs)
  assert.equal(merged.inlineMaxMs, 250)
  assert.deepEqual(merged.providers, [])
  assert.equal(merged.resumePrompt, config.resumePrompt)
})

test('defaults stay frozen and complete', () => {
  assert.ok(Object.isFrozen(DEFAULTS))
  assert.ok(config.resumePrompt.startsWith('[quota-resume]'))
})
