import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { createMoonskyServer } from '../src/server.js'

void test('MOONSKY serves built operator HTML and confines static asset paths', async () => {
  const app = createMoonskyServer(parseConfig({}))
  try {
    await app.ready()
    const root = await app.inject({ method: 'GET', url: '/' })
    assert.equal(root.statusCode, 200)
    assert.match(root.body, /MOONSKY \/\/ Operator Inbox/)
    const traversal = await app.inject({ method: 'GET', url: '/assets/%2e%2e%2f..%2f..%2fpackage.json' })
    assert.equal(traversal.statusCode, 404)
    const apiStillRegistered = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(apiStillRegistered.statusCode, 200)
  } finally { await app.close() }
})

void test('operator client keeps sessions in memory and sends only bearer credentials', async () => {
  const { fetchChannels, fetchDeliveryAttempts, login, logout } = await import('../client/lib/api.js')
  const originalFetch = globalThis.fetch
  let observed: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    observed = init
    return new Response(JSON.stringify({ ok: true, data: [], timestamp: 'now' }), { status: 200 })
  }
  try {
    await fetchChannels('operator-session-example', new AbortController().signal)
    const headers = new Headers(observed?.headers)
    assert.equal(headers.get('authorization'), 'Bearer operator-session-example')
    assert.equal(headers.has('x-moonsky-key'), false)
    assert.equal(observed?.credentials, 'omit')
    assert.equal(observed?.redirect, 'error')

    let requestedPath = ''
    globalThis.fetch = async (input, init) => {
      requestedPath = String(input)
      observed = init
      return new Response(JSON.stringify({ ok: true, data: [], timestamp: 'now' }), { status: 200 })
    }
    await fetchDeliveryAttempts('conversation/one', 'operator-session-example', new AbortController().signal)
    assert.equal(requestedPath, '/api/v1/conversations/conversation%2Fone/delivery-attempts?limit=100')
    assert.equal(new Headers(observed?.headers).get('authorization'), 'Bearer operator-session-example')

    globalThis.fetch = async (input, init) => {
      requestedPath = String(input)
      observed = init
      return new Response(JSON.stringify({
        ok: true,
        data: { token: 'session-token', expiresAt: 'later', operator: { login: 'operator', role: 'admin' } },
        timestamp: 'now',
      }), { status: 200 })
    }
    const result = await login('operator', 'synthetic-password', new AbortController().signal)
    assert.equal(requestedPath, '/api/v1/auth/login')
    assert.equal(observed?.method, 'POST')
    assert.equal(observed?.credentials, 'omit')
    assert.equal(new Headers(observed?.headers).has('authorization'), false)
    assert.equal(new Headers(observed?.headers).get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(String(observed?.body)), { login: 'operator', password: 'synthetic-password' })
    assert.equal(result.token, 'session-token')

    globalThis.fetch = async (_input, init) => {
      observed = init
      return new Response(null, { status: 204 })
    }
    await logout('session-token', new AbortController().signal)
    assert.equal(observed?.method, 'POST')
    assert.equal(new Headers(observed?.headers).get('authorization'), 'Bearer session-token')
  } finally { globalThis.fetch = originalFetch }
})
