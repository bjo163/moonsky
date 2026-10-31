import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  createChannelAccount,
  createMoonskyStore,
  createOperator,
  createOperatorSession,
  findConversation,
  listConversations,
  listMessages,
  migrateMoonskyStore,
  recordDeliveryAttempt,
} from '@moonsky/store'
import { TelegramAdapter } from '@moonsky/telegram'
import type { MoonskyChannel } from '../src/channels.js'
import { createTelegramMoonskyChannel, DuplicateMoonskyChannelIdError, MoonskyChannelRegistry } from '../src/channels.js'
import type { MoonskyConfig } from '../src/config.js'
import { hashPassword, hashToken, newSessionToken } from '../src/session.js'
import { createMoonskyServer } from '../src/server.js'
import { MoonskyEventBus } from '../src/ws.js'
import { fetchMessages, openOperatorSocket } from '../client/lib/api.js'

const SERVICE_KEY = 'synthetic-moonsky-service-key-value-00001'
const TELEGRAM_SECRET = 'synthetic-moonsky-telegram-webhook-secret-01'
const OPERATOR_PASSWORD = 'synthetic-moonsky-operator-password'
const databaseUrl = process.env.DATABASE_URL

function testConfig(overrides: Partial<MoonskyConfig> = {}): MoonskyConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3005,
    databaseUrl: '',
    serviceKey: SERVICE_KEY,
    telegramBotToken: '',
    telegramWebhookSecret: '',
    bootstrapLogin: 'admin',
    bootstrapPassword: '',
    ...overrides,
  }
}

class TestChannel extends EventEmitter implements MoonskyChannel {
  readonly id: string
  readonly label = 'Fixture'
  state = 'configured'
  sends = 0

  constructor(readonly channelAccountId: string, id = 'fixture') {
    super()
    this.id = id
  }

  status() {
    return { state: this.state, detail: { qr: 'synthetic-private-qr' } }
  }

  async send({ text }: { to: string; text: string }) {
    this.sends += 1
    assert.ok(text.length > 0)
    return { status: 'accepted' as const, providerMessageId: `provider-${this.sends}` }
  }

  async start() {
    this.state = 'open'
  }

  async logout() {
    this.state = 'logged-out'
  }
}

void test('MOONSKY channel registry fails on duplicate ids with a named error', () => {
  const registry = new MoonskyChannelRegistry()
  const first = new TestChannel('unused')
  registry.register(first)
  assert.throws(() => registry.register(new TestChannel('unused')), DuplicateMoonskyChannelIdError)
  assert.equal(registry.get('fixture'), first)
})

void test('MOONSKY registers Telegram transport as a sendable control-plane channel', async () => {
  const adapter = new TelegramAdapter({
    botToken: 'synthetic-token-never-used',
    webhookSecret: TELEGRAM_SECRET,
    externalAccountId: 'default',
    authRef: 'secret://test/telegram-bot',
    store: {} as never,
    api: { sendMessage: async () => ({ message_id: 42 }) } as never,
  })
  const registry = new MoonskyChannelRegistry()
  registry.register(createTelegramMoonskyChannel(adapter, 'synthetic-account-id'))
  const channel = registry.get('telegram')
  assert.ok(channel)
  assert.equal(channel.channelAccountId, 'synthetic-account-id')
  assert.deepEqual(await channel.status(), { state: 'configured' })
  assert.deepEqual(await channel.send({ to: 'chat-fixture', text: 'synthetic send' }), {
    status: 'accepted', providerMessageId: '42',
  })
  await channel.logout?.()
  assert.deepEqual(await channel.status(), { state: 'stopped' })
})

void test('MOONSKY refuses service credentials and unavailable sessions on the event stream', { timeout: 10_000 }, async (t) => {
  const events = new MoonskyEventBus()
  const app = createMoonskyServer(testConfig(), { events })
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(async () => app.close())

  const serviceSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(serviceSocket)
  const serviceAuth = nextFrame(serviceSocket)
  const serviceClosed = waitForClose(serviceSocket)
  serviceSocket.send(JSON.stringify({ type: 'auth', serviceKey: SERVICE_KEY }))
  assert.deepEqual(await within(serviceAuth, 'service-key WebSocket rejection'), { type: 'auth', ok: false, error: 'forbidden' })
  assert.equal(await within(serviceClosed, 'service-key WebSocket close'), 1008)
  assert.equal(events.listenerCount('event'), 0, 'service keys never subscribe to the event stream')

  const anonymousSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(anonymousSocket)
  const anonymousAuth = nextFrame(anonymousSocket)
  const anonymousClosed = waitForClose(anonymousSocket)
  anonymousSocket.send(JSON.stringify({ type: 'auth', authorization: `Bearer ${newSessionToken()}` }))
  assert.deepEqual(await within(anonymousAuth, 'session-less WebSocket rejection'), { type: 'auth', ok: false, error: 'auth_unavailable' })
  assert.equal(await within(anonymousClosed, 'session-less WebSocket close'), 1008)
  assert.equal(events.listenerCount('event'), 0, 'unavailable authentication never subscribes')

  const invalidSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(invalidSocket)
  const invalidClosed = waitForClose(invalidSocket)
  invalidSocket.send('not-a-frame')
  assert.equal(await within(invalidClosed, 'invalid frame close'), 1008)
  assert.equal(events.listenerCount('event'), 0)
})

void test('MOONSKY keeps credentials, QR payloads and message bodies out of info logs', async (t) => {
  const logged: string[] = []
  const channel = new TestChannel('unused')
  const channels = new MoonskyChannelRegistry()
  channels.register(channel)
  const app = createMoonskyServer(testConfig(), {
    channels,
    logger: { level: 'info', stream: { write: (line: string) => { logged.push(line) } } as never },
  })
  t.after(async () => app.close())

  const anonymous = await app.inject().get('/api/v1/channels')
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.body.includes('synthetic-private-qr'), false)

  const register = await app.inject().post('/api/v1/channels/register').headers({ 'x-moonsky-key': SERVICE_KEY })
  assert.equal(register.statusCode, 200)
  assert.equal(register.body.includes('synthetic-private-qr'), false, 'channel detail is not part of the registry projection')

  const send = await app.inject({
    method: 'POST', url: '/api/v1/send', headers: { 'x-moonsky-key': SERVICE_KEY },
    payload: { channel: 'fixture', to: 'chat-fixture', text: 'synthetic outbound body' },
  })
  assert.equal(send.statusCode, 503)

  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: 'operator', password: 'synthetic-operator-password' },
  })
  assert.equal(login.statusCode, 503)

  const output = logged.join('')
  assert.ok(output.length > 0, 'the info logger actually captured output')
  for (const secret of [SERVICE_KEY, 'synthetic-operator-password', 'synthetic-private-qr', 'synthetic outbound body']) {
    assert.equal(output.includes(secret), false, `info logs must not contain ${secret}`)
  }
})

void test('MOONSKY standalone operator sessions, service scope and D18 control plane', {
  timeout: 60_000,
  skip: databaseUrl ? false : 'DATABASE_URL is not set, so the MOONSKY control-plane evidence cannot run',
}, async (t) => {
  assert.ok(databaseUrl)
  const database = new URL(databaseUrl)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(database.hostname), 'database test is local-only')

  const store = createMoonskyStore(databaseUrl)
  await migrateMoonskyStore(store)
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const passwordHash = await hashPassword(OPERATOR_PASSWORD)
  const admin = await createOperator(store.db, { login: `admin-${suffix}`, passwordHash, role: 'admin' })
  const viewer = await createOperator(store.db, { login: `viewer-${suffix}`, passwordHash, role: 'viewer' })
  const throttled = await createOperator(store.db, { login: `throttled-${suffix}`, passwordHash, role: 'admin' })
  const disabled = await createOperator(store.db, { login: `disabled-${suffix}`, passwordHash, role: 'admin' })
  await store.client`UPDATE moonsky.operator_users SET disabled = true WHERE id = ${disabled.id}`

  const expiredToken = newSessionToken()
  await createOperatorSession(store.db, {
    operatorId: admin.id, tokenHash: hashToken(expiredToken), expiresAt: new Date(Date.now() - 60_000),
  })
  const logoutToken = newSessionToken()
  await createOperatorSession(store.db, {
    operatorId: admin.id, tokenHash: hashToken(logoutToken), expiresAt: new Date(Date.now() + 120_000),
  })
  const disabledToken = newSessionToken()
  await createOperatorSession(store.db, {
    operatorId: disabled.id, tokenHash: hashToken(disabledToken), expiresAt: new Date(Date.now() + 120_000),
  })

  const account = await createChannelAccount(store.db, {
    provider: 'telegram',
    externalAccountId: `m38-test-${suffix}`,
    authRef: 'secret://test/telegram-bot',
    status: 'connected',
  })
  const fixtureAccount = await createChannelAccount(store.db, {
    provider: 'fixture',
    externalAccountId: `m38-fixture-${suffix}`,
    authRef: 'secret://test/fixture',
    status: 'connected',
  })
  const telegram = new TelegramAdapter({
    botToken: 'synthetic-token-never-used',
    webhookSecret: TELEGRAM_SECRET,
    externalAccountId: account.externalAccountId,
    authRef: account.authRef,
    store: store.db,
    api: { sendMessage: async () => ({ message_id: 42 }) } as never,
  })
  const channel = new TestChannel(fixtureAccount.id)
  const channels = new MoonskyChannelRegistry()
  channels.register(createTelegramMoonskyChannel(telegram, account.id))
  channels.register(channel)

  const now = Date.now()
  const events = new MoonskyEventBus()
  const logged: string[] = []
  const app = createMoonskyServer(testConfig({
    databaseUrl,
    telegramBotToken: 'synthetic-token-never-used',
    telegramWebhookSecret: TELEGRAM_SECRET,
  }), {
    store: store.db,
    channels,
    telegram,
    events,
    now: () => now,
    logger: { level: 'info', stream: { write: (line: string) => { logged.push(line) } } as never },
  })
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    await app.close()
    await store.client`DELETE FROM moonsky.channel_accounts WHERE id IN (${account.id}, ${fixtureAccount.id})`
    await store.client`DELETE FROM moonsky.operator_users WHERE id IN (${admin.id}, ${viewer.id}, ${throttled.id}, ${disabled.id})`
    await store.client.end({ timeout: 5 })
  })

  const anonymous = await app.inject().get('/api/v1/channels')
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.body.includes('synthetic-private-qr'), false)
  const cookieOnly = await app.inject().get('/api/v1/channels').headers({ cookie: `session=${logoutToken}` })
  assert.equal(cookieOnly.statusCode, 401, 'operator sessions travel only in the Authorization header')

  const wrongPassword = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: admin.login, password: 'synthetic-wrong-password' },
  })
  assert.equal(wrongPassword.statusCode, 401)
  const unknownLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: `missing-${suffix}`, password: OPERATOR_PASSWORD },
  })
  assert.equal(unknownLogin.statusCode, 401)

  const adminLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: admin.login, password: OPERATOR_PASSWORD },
  })
  assert.equal(adminLogin.statusCode, 200)
  const adminSession = adminLogin.json().data as { token: string; expiresAt: string; operator: { login: string; role: string } }
  assert.equal(adminSession.operator.login, admin.login)
  assert.equal(adminSession.operator.role, 'admin')
  assert.ok(new Date(adminSession.expiresAt).getTime() > now)
  const adminToken = adminSession.token
  assert.equal(adminLogin.body.includes(OPERATOR_PASSWORD), false, 'login responses never echo the password')

  const me = await app.inject().get('/api/v1/auth/me').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(me.statusCode, 200)
  assert.deepEqual(me.json().data, { login: admin.login, role: 'admin' })

  const viewerLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: viewer.login, password: OPERATOR_PASSWORD },
  })
  assert.equal(viewerLogin.statusCode, 200)
  const viewerToken = (viewerLogin.json().data as { token: string }).token

  const expired = await app.inject().get('/api/v1/auth/me').headers({ authorization: `Bearer ${expiredToken}` })
  assert.equal(expired.statusCode, 401)
  const disabledRead = await app.inject().get('/api/v1/auth/me').headers({ authorization: `Bearer ${disabledToken}` })
  assert.equal(disabledRead.statusCode, 401, 'disabled operators cannot use existing sessions')

  const logout = await app.inject().post('/api/v1/auth/logout').headers({ authorization: `Bearer ${logoutToken}` })
  assert.equal(logout.statusCode, 204)
  const afterLogout = await app.inject().get('/api/v1/auth/me').headers({ authorization: `Bearer ${logoutToken}` })
  assert.equal(afterLogout.statusCode, 401)
  const serviceLogout = await app.inject().post('/api/v1/auth/logout').headers({ 'x-moonsky-key': SERVICE_KEY })
  assert.equal(serviceLogout.statusCode, 403, 'the service credential cannot manage operator sessions')

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { login: throttled.login, password: 'synthetic-wrong-password' },
    })
    assert.equal(failed.statusCode, 401)
  }
  const throttledLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: throttled.login, password: OPERATOR_PASSWORD },
  })
  assert.equal(throttledLogin.statusCode, 429, 'repeated failures throttle the login key')

  const serviceChannels = await app.inject().get('/api/v1/channels').headers({ 'x-moonsky-key': SERVICE_KEY })
  assert.equal(serviceChannels.statusCode, 403, 'service credentials are scoped to machine send and registration')
  const serviceRegister = await app.inject().post('/api/v1/channels/register').headers({ 'x-moonsky-key': SERVICE_KEY })
  assert.equal(serviceRegister.statusCode, 200)
  assert.equal(serviceRegister.json().data.length, 2)
  assert.equal(serviceRegister.body.includes('synthetic-private-qr'), false)
  const adminRegister = await app.inject().post('/api/v1/channels/register').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(adminRegister.statusCode, 403, 'registration is service-only')

  const adminChannels = await app.inject().get('/api/v1/channels').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(adminChannels.statusCode, 200)
  assert.equal(adminChannels.json().data.find((entry: { id: string }) => entry.id === 'telegram').label, 'Telegram')

  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/send',
    headers: { 'x-moonsky-key': SERVICE_KEY },
    payload: { channel: 'telegram', to: 'chat-fixture', text: 'synthetic outbound body' },
  })
  assert.equal(sent.statusCode, 200)
  assert.equal(sent.json().data.status, 'accepted')
  const conversations = await within(listConversations(store.db, account.id), 'persisted conversations')
  assert.equal(conversations.length, 1)
  const conversation = conversations[0]
  assert.ok(conversation)
  const outbound = await within(listMessages(store.db, conversation.id), 'persisted messages')
  assert.equal(outbound[0]?.body, 'synthetic outbound body')
  const outboundMessage = outbound[0]
  assert.ok(outboundMessage)
  await within(recordDeliveryAttempt(store.db, {
    messageId: outboundMessage.id,
    attemptNumber: 2,
    status: 'failed',
    providerMessageId: 'sensitive-provider-reference',
    errorCode: 'provider_error',
    errorSummary: 'Sensitive provider response must not be projected.',
  }), 'persisted retry attempt')

  const conversationRead = await app.inject().get('/api/v1/conversations').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(conversationRead.statusCode, 200)
  const projectedConversation = conversationRead.json().data[0] as Record<string, unknown>
  assert.deepEqual(Object.keys(projectedConversation).sort(), [
    'channelAccountId', 'createdAt', 'externalId', 'id', 'lastMessageAt', 'status', 'title', 'updatedAt',
  ])
  const messageRead = await app.inject().get(`/api/v1/conversations/${conversation.id}/messages`).headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(messageRead.statusCode, 200)
  const projectedMessage = messageRead.json().data[0] as Record<string, unknown>
  assert.deepEqual(Object.keys(projectedMessage).sort(), [
    'body', 'conversationId', 'createdAt', 'direction', 'externalMessageId', 'id', 'senderId', 'status',
  ])
  const attemptRead = await app.inject().get(`/api/v1/conversations/${conversation.id}/delivery-attempts`).headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(attemptRead.statusCode, 200)
  const attempts = attemptRead.json().data as Array<Record<string, unknown>>
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0]?.attemptNumber, 2, 'attempts are listed newest first')
  assert.deepEqual(Object.keys(attempts[0] ?? {}).sort(), ['attemptNumber', 'attemptedAt', 'id', 'messageId', 'status'])
  assert.equal(JSON.stringify(attempts).includes('sensitive-provider-reference'), false)
  assert.equal(JSON.stringify(attempts).includes('Sensitive provider response'), false)
  const accountRead = await app.inject().get('/api/v1/channels/accounts').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(accountRead.statusCode, 200)
  assert.equal('authRef' in (accountRead.json().data[0] as object), false)

  const viewerHeaders = { authorization: `Bearer ${viewerToken}` }
  const viewerReads = [
    app.inject().get('/api/v1/channels').headers(viewerHeaders),
    app.inject().get('/api/v1/conversations').headers(viewerHeaders),
    app.inject().get(`/api/v1/conversations/${conversation.id}/messages`).headers(viewerHeaders),
    app.inject().get(`/api/v1/conversations/${conversation.id}/delivery-attempts`).headers(viewerHeaders),
    app.inject().get('/api/v1/channels/accounts').headers(viewerHeaders),
    app.inject().get('/api/v1/auth/me').headers(viewerHeaders),
  ]
  for (const request of viewerReads) assert.equal((await request).statusCode, 200, 'viewers may read the D18 surface')

  const viewerWrites = [
    app.inject().post('/api/v1/send').headers(viewerHeaders).payload({ channel: 'telegram', to: 'chat-fixture', text: 'denied' }),
    app.inject().post('/api/v1/broadcast').headers(viewerHeaders).payload({ to: 'chat-fixture', text: 'denied' }),
    app.inject().post('/api/v1/channels/telegram/start').headers(viewerHeaders),
    app.inject().post('/api/v1/channels/telegram/logout').headers(viewerHeaders),
    app.inject().post('/api/v1/channels/register').headers(viewerHeaders),
  ]
  for (const request of viewerWrites) assert.equal((await request).statusCode, 403, 'viewers cannot change provider state')

  const inboundUpdate = JSON.stringify({
    update_id: Date.now(),
    message: { from: { id: 77 }, chat: { id: 88 }, text: 'synthetic inbound body' },
  })
  const badSecret = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/telegram',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    payload: inboundUpdate,
  })
  assert.equal(badSecret.statusCode, 401)
  const unknownProvider = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/unknown',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: inboundUpdate,
  })
  assert.equal(unknownProvider.statusCode, 404)
  const acceptedTelegram = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/telegram',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: inboundUpdate,
  })
  assert.equal(acceptedTelegram.statusCode, 202)
  const inboundConversation = await findConversation(store.db, account.id, '88')
  assert.ok(inboundConversation)
  const inboundMessages = await listMessages(store.db, inboundConversation.id)
  assert.equal(inboundMessages[0]?.body, 'synthetic inbound body')
  const replayTelegram = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/telegram',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: inboundUpdate,
  })
  assert.equal(replayTelegram.statusCode, 202)
  assert.equal(replayTelegram.json().data.duplicate, true)

  const serviceSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(serviceSocket)
  const serviceAuth = nextFrame(serviceSocket)
  const serviceClosed = waitForClose(serviceSocket)
  serviceSocket.send(JSON.stringify({ type: 'auth', serviceKey: SERVICE_KEY }))
  assert.deepEqual(await within(serviceAuth, 'service-key WebSocket rejection'), { type: 'auth', ok: false, error: 'forbidden' })
  assert.equal(await within(serviceClosed, 'service-key WebSocket close'), 1008)

  const viewerSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(viewerSocket)
  const viewerAuth = nextFrame(viewerSocket)
  const viewerClosed = waitForClose(viewerSocket)
  viewerSocket.send(JSON.stringify({ type: 'auth', authorization: `Bearer ${viewerToken}` }))
  assert.deepEqual(await within(viewerAuth, 'non-admin WebSocket rejection'), { type: 'auth', ok: false, error: 'forbidden' })
  assert.equal(await within(viewerClosed, 'non-admin WebSocket close'), 1008)
  assert.equal(events.listenerCount('event'), 0, 'rejected sockets never subscribe to the event stream')

  const operatorSocket = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws')
  await waitForOpen(operatorSocket)
  const firstOperatorFrame = nextFrame(operatorSocket)
  operatorSocket.send(JSON.stringify({ type: 'auth', authorization: `Bearer ${adminToken}` }))
  assert.deepEqual(await within(firstOperatorFrame, 'admin WebSocket auth'), { type: 'auth', ok: true })

  const stateFrame = nextFrame(operatorSocket)
  const start = await app.inject().post('/api/v1/channels/fixture/start').headers({ authorization: `Bearer ${adminToken}` })
  assert.equal(start.statusCode, 200)
  const stateEvent = await within(stateFrame, 'channel.state frame') as { type: string; channelId: string; state: string; timestamp: string }
  assert.equal(stateEvent.type, 'channel.state')
  assert.equal(stateEvent.channelId, 'fixture')
  assert.equal(stateEvent.state, 'open')
  assert.ok(stateEvent.timestamp)

  const qrFrame = nextFrame(operatorSocket)
  channel.emit('qr', 'synthetic-qr-payload')
  const qrEvent = await within(qrFrame, 'admin channel.qr frame') as { type: string; qr: string }
  assert.equal(qrEvent.type, 'channel.qr')
  assert.equal(qrEvent.qr, 'synthetic-qr-payload')

  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(serverUrl) })
  const uiState: { socket: string; events: Record<string, unknown>[] } = { socket: 'idle', events: [] }
  let resolveUiConnected: () => void = () => {}
  const uiConnected = new Promise<void>((resolve) => { resolveUiConnected = resolve })
  let resolveInbound: (event: Record<string, unknown>) => void = () => {}
  const uiInboundEvent = new Promise<Record<string, unknown>>((resolve) => { resolveInbound = resolve })
  const uiSocket = openOperatorSocket(adminToken, {
    onState: (state) => {
      uiState.socket = state
      if (state === 'connected') resolveUiConnected()
    },
    onEvent: (event) => {
      uiState.events = [event, ...uiState.events].slice(0, 30)
      if (event.type === 'message.inbound') resolveInbound(event)
    },
  })
  t.after(() => {
    uiSocket.close()
    operatorSocket.close()
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation)
    else Reflect.deleteProperty(globalThis, 'location')
  })
  await within(uiConnected, 'operator UI WebSocket authentication')

  const uiWebhook = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/telegram',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: JSON.stringify({
      update_id: Date.now() + 100,
      message: { from: { id: 77 }, chat: { id: 88 }, text: 'synthetic inbound UI body' },
    }),
  })
  assert.equal(uiWebhook.statusCode, 202)
  const uiEvent = await within(uiInboundEvent, 'inbound WebSocket event to UI state')
  assert.equal(uiEvent.type, 'message.inbound')
  assert.equal(uiState.socket, 'connected')
  assert.equal(uiState.events.find((event) => event.type === 'message.inbound')?.messageId, uiEvent.messageId)

  const originalUiFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? new URL(input, serverUrl) : input
    return originalUiFetch(target, init)
  }) as typeof fetch
  try {
    const uiMessages = await fetchMessages(inboundConversation.id, adminToken, new AbortController().signal)
    assert.ok(uiMessages.data.some((message) => message.body === 'synthetic inbound UI body'))
  } finally {
    globalThis.fetch = originalUiFetch
  }

  const output = logged.join('')
  assert.ok(output.length > 0, 'the info logger actually captured output')
  for (const secret of [
    adminToken, viewerToken, OPERATOR_PASSWORD, SERVICE_KEY,
    'synthetic-private-qr', 'synthetic-qr-payload', 'synthetic outbound body', 'synthetic inbound body',
  ]) {
    assert.equal(output.includes(secret), false, `info logs must not contain ${secret}`)
  }
})

function waitForOpen(socket: WebSocket): Promise<void> {
  return within(new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true })
  }), 'WebSocket open')
}

function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      try {
        resolve(JSON.parse(String(event.data)) as unknown)
      } catch {
        reject(new Error('WebSocket sent invalid JSON'))
      }
    }, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket errored')), { once: true })
  })
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true })
  })
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
