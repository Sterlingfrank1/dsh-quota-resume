import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, normalizeConfig } from '../index.js'

/** Minimal Cordis-shaped context: only what this plugin touches. */
function makeContext(services = {}) {
  const listeners = new Map()
  const disposers = []
  const events = []
  const ctx = {
    logger: {
      info: (...args) => { events.push(['info', ...args]) },
      warn: (...args) => { events.push(['warn', ...args]) },
      error: (...args) => { events.push(['error', ...args]) },
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    reflect: { get: name => services[name] },
  }
  return { ctx, listeners, disposers, events }
}

/** A schedule service stand-in that records calls and serves one seeded task. */
function makeSchedule(seed = []) {
  const tasks = [...seed]
  const calls = []
  let counter = 0
  return {
    tasks,
    calls,
    async list() {
      return { items: tasks.filter(task => task.status !== 'ended'), shown: tasks.length, total: tasks.length, limit: 200, offset: 0 }
    },
    async create(request) {
      counter += 1
      const entry = { id: `task-${counter}`, status: 'active', ...request }
      tasks.push(entry)
      calls.push(['create', request])
      return entry
    },
    async edit(request) {
      calls.push(['edit', request])
      const task = tasks.find(item => item.id === request.id)
      if (request.action === 'delete') {
        const index = tasks.indexOf(task)
        if (index >= 0) tasks.splice(index, 1)
        return { id: request.id, deleted: true }
      }
      Object.assign(task, request.patch ?? {})
      return task
    },
  }
}

function payload({ code = 'QUOTA', sessionId = 's-1', provider = 'dsh-opencode-go' } = {}) {
  return {
    agent: { session: { id: sessionId } },
    provider,
    turn: 1,
    step: 1,
    retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    failure: { message: 'quota exceeded', code },
    signal: new AbortController().signal,
  }
}

const terminal = async () => undefined

test('inline lane retries the same turn after a short wait', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { quotaBaseMs: 250, inlineMaxMs: 5_000 })
  const result = await listeners.get('agent/request-error')(payload(), terminal)
  assert.deepEqual(result, { kind: 'retry' })
})

test('cancelling during the wait leaves the failure terminal', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { quotaBaseMs: 5_000, inlineMaxMs: 10_000 })
  const controller = new AbortController()
  const request = payload()
  request.signal = controller.signal
  setTimeout(() => controller.abort(), 40)
  const result = await listeners.get('agent/request-error')(request, terminal)
  assert.equal(result, undefined)
})

test('a window failure parks the session with one durable task', async () => {
  const schedule = makeSchedule()
  const { ctx, listeners } = makeContext({ schedule })
  apply(ctx, { quotaRetries: 0, probeInitialMs: 600_000, probeJitterRatio: 0 })
  const result = await listeners.get('agent/request-error')(payload(), terminal)
  assert.equal(result, undefined)
  assert.equal(schedule.calls.length, 1)
  const [kind, request] = schedule.calls[0]
  assert.equal(kind, 'create')
  assert.deepEqual(request.target, { kind: 'session', sessionId: 's-1' })
  assert.equal(request.timing.kind, 'at')
  const delay = Date.parse(request.timing.at) - Date.now()
  assert.ok(delay > 590_000 && delay <= 600_000, `resume in ${delay}ms`)
  assert.ok(request.prompt.startsWith('[quota-resume]'))
})

test('a second failure reuses the existing parked task instead of stacking', async () => {
  const schedule = makeSchedule([{
    id: 'task-existing',
    status: 'active',
    title: '额度恢复后自动继续',
    prompt: '[quota-resume] earlier',
    target: { kind: 'session', sessionId: 's-1' },
  }])
  const { ctx, listeners } = makeContext({ schedule })
  apply(ctx, { quotaRetries: 0, probeInitialMs: 600_000 })
  await listeners.get('agent/request-error')(payload(), terminal)
  assert.equal(schedule.calls.filter(call => call[0] === 'create').length, 0)
  assert.equal(schedule.calls.filter(call => call[0] === 'edit').length, 1)
})

test('without a schedule service the turn keeps retrying in place', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx, { quotaRetries: 0, fallbackDelayMs: 250 })
  const result = await listeners.get('agent/request-error')(payload(), terminal)
  assert.deepEqual(result, { kind: 'retry' })
})

test('an exhausted balance is reported without a retry or a task', async () => {
  const schedule = makeSchedule()
  const { ctx, listeners, events } = makeContext({ schedule })
  apply(ctx)
  const result = await listeners.get('agent/request-error')(payload({ code: 'ACCOUNT_QUOTA' }), terminal)
  assert.equal(result, undefined)
  assert.equal(schedule.calls.length, 0)
  assert.ok(events.some(([level]) => level === 'warn'))
})

test('other failures are delegated untouched', async () => {
  const { ctx, listeners } = makeContext()
  apply(ctx)
  let delegated = 0
  const next = async () => { delegated += 1; return undefined }
  const result = await listeners.get('agent/request-error')(payload({ code: 'SERVER' }), next)
  assert.equal(result, undefined)
  assert.equal(delegated, 1)
})

test('a successful assistant message cancels a stale wake-up', async () => {
  const schedule = makeSchedule()
  const { ctx, listeners } = makeContext({ schedule })
  apply(ctx, { quotaRetries: 0 })
  await listeners.get('agent/request-error')(payload(), terminal)
  assert.equal(schedule.tasks.length, 1)
  listeners.get('session/event')({ id: 's-1' }, { type: 'assistant/message' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(schedule.calls.filter(call => call[0] === 'edit' && call[1].action === 'delete').length, 1)
  assert.equal(schedule.tasks.length, 0)
})

test('normalizeConfig keeps the documented defaults', () => {
  const config = normalizeConfig({})
  assert.equal(config.quotaRetries, 2)
  assert.equal(config.inlineMaxMs, 300_000)
  assert.equal(config.probeInitialMs, 600_000)
  assert.equal(config.maxProbes, 0)
})
