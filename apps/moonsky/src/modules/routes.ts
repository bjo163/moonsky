import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  appendMessage,
  createConversation,
  findConversation,
  getChannelAccount,
  getConversation,
  listDeliveryAttempts,
  listChannelAccounts,
  listMessages,
  listRecentConversations,
  recordDeliveryAttempt,
} from '@moonsky/store'
import type { ChannelAccount, Conversation, Message, MoonskyDatabase } from '@moonsky/store'
import { createMoonskyAuthenticator } from '../auth.js'
import type { AuthOptions, MoonskyPrincipal } from '../auth.js'
import type { MoonskyChannel } from '../channels.js'
import type { MoonskyEventBus } from '../ws.js'

const errorSchema = {
  type: 'object',
  required: ['ok', 'error', 'timestamp'],
  additionalProperties: false,
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['statusCode', 'message'],
      additionalProperties: false,
      properties: { statusCode: { type: 'integer' }, message: { type: 'string' } },
    },
    timestamp: { type: 'string' },
  },
} as const

function objectEnvelope(data: Record<string, unknown>) {
  return {
    type: 'object',
    required: ['ok', 'data', 'timestamp'],
    properties: {
      ok: { const: true },
      data,
      timestamp: { type: 'string' },
    },
    additionalProperties: false,
  }
}

function arrayEnvelope(item: Record<string, unknown>) {
  return {
    type: 'object',
    required: ['ok', 'data', 'timestamp'],
    properties: {
      ok: { const: true },
      data: { type: 'array', items: item },
      timestamp: { type: 'string' },
    },
    additionalProperties: false,
  }
}

const channelSchema = {
  type: 'object', required: ['id', 'label', 'state'], additionalProperties: false,
  properties: { id: { type: 'string' }, label: { type: 'string' }, state: { type: 'string' } },
}
const channelAccountSchema = {
  type: 'object', required: ['id', 'provider', 'externalAccountId', 'displayName', 'status'], additionalProperties: false,
  properties: {
    id: { type: 'string' }, provider: { type: 'string' }, externalAccountId: { type: 'string' },
    displayName: { type: ['string', 'null'] }, status: { type: 'string' },
  },
}
const conversationSchema = {
  type: 'object',
  required: ['id', 'channelAccountId', 'externalId', 'title', 'status', 'lastMessageAt', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' }, channelAccountId: { type: 'string' }, externalId: { type: 'string' },
    title: { type: ['string', 'null'] }, status: { type: 'string' },
    lastMessageAt: { type: ['string', 'null'] }, createdAt: { type: 'string' }, updatedAt: { type: 'string' },
  },
}
const messageSchema = {
  type: 'object',
  required: ['id', 'conversationId', 'externalMessageId', 'direction', 'senderId', 'body', 'status', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' }, conversationId: { type: 'string' },
    externalMessageId: { type: ['string', 'null'] }, direction: { type: 'string' },
    senderId: { type: ['string', 'null'] }, body: { type: 'string' }, status: { type: 'string' }, createdAt: { type: 'string' },
  },
}
const deliveryAttemptSchema = {
  type: 'object',
  required: ['id', 'messageId', 'attemptNumber', 'status', 'attemptedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' }, messageId: { type: 'string' }, attemptNumber: { type: 'integer' },
    status: { type: 'string' }, attemptedAt: { type: 'string' },
  },
}
const sendResultSchema = {
  type: 'object', required: ['channel', 'to', 'status', 'providerMessageId', 'messageId'], additionalProperties: false,
  properties: {
    channel: { type: 'string' }, to: { type: 'string' }, status: { const: 'accepted' },
    providerMessageId: { type: 'string' }, messageId: { type: 'string' },
  },
}
const broadcastResultSchema = {
  oneOf: [
    sendResultSchema,
    {
      type: 'object', required: ['channel', 'ok', 'status'], additionalProperties: false,
      properties: { channel: { type: 'string' }, ok: { const: false }, status: { const: 'failed' } },
    },
  ],
}
const controlResultSchema = {
  type: 'object', required: ['id', 'state'], additionalProperties: false,
  properties: { id: { type: 'string' }, state: { type: 'string' } },
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

export interface MoonskyRoutesOptions extends AuthOptions {
  store?: MoonskyDatabase
  getChannels: () => MoonskyChannel[]
  events: MoonskyEventBus
}

export function registerMoonskyRoutes(app: FastifyInstance, options: MoonskyRoutesOptions): void {
  const authenticate = createMoonskyAuthenticator(options)

  /** The registry view: id/label/state only — never QR, JIDs, accounts or message content. */
  const channelSummaries = async () => Promise.all(options.getChannels().map(async (channel) => ({
    id: channel.id,
    label: channel.label,
    state: (await channel.status()).state,
  })))

  app.get('/api/v1/channels', {
    schema: { response: { 200: arrayEnvelope(channelSchema), 401: errorSchema, 403: errorSchema, 503: errorSchema } },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'read')) return
    return ok(reply, await channelSummaries())
  })

  // A scoped service client registers as a consumer and receives the registry
  // MOONSKY owns. Stateless on purpose — it creates no channel, writes no row,
  // and it is the only service-key read on this surface. Widening the key to
  // start/logout/conversations stays refused by policy below.
  app.post('/api/v1/channels/register', {
    schema: { response: { 200: arrayEnvelope(channelSchema), 401: errorSchema, 403: errorSchema, 503: errorSchema } },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'service')) return
    return ok(reply, await channelSummaries())
  })

  app.post('/api/v1/send', {
    schema: {
      body: {
        type: 'object', required: ['channel', 'to', 'text'], additionalProperties: false,
        properties: {
          channel: { type: 'string', minLength: 1, maxLength: 32 },
          to: { type: 'string', minLength: 1, maxLength: 255 },
          text: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
      response: { 200: objectEnvelope(sendResultSchema), 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 502: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'admin-or-service-send')) return
    const body = request.body as { channel: string; to: string; text: string }
    const channel = options.getChannels().find((candidate) => candidate.id === body.channel)
    if (!channel) return fail(reply, 404, 'channel_not_found', 'Channel not found.')
    return sendAndPersist(reply, options, channel, body.to, body.text)
  })

  app.post('/api/v1/broadcast', {
    schema: {
      body: {
        type: 'object', required: ['to', 'text'], additionalProperties: false,
        properties: { to: { type: 'string', minLength: 1, maxLength: 255 }, text: { type: 'string', minLength: 1, maxLength: 4096 } },
      },
      response: { 200: arrayEnvelope(broadcastResultSchema), 400: errorSchema, 401: errorSchema, 403: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'admin')) return
    if (!options.store) return fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    const body = request.body as { to: string; text: string }
    const results = await Promise.all(options.getChannels().map(async (channel) => {
      const result = await sendAndPersist(reply, options, channel, body.to, body.text, false)
      return result
    }))
    return ok(reply, results)
  })

  app.post('/api/v1/channels/:id/start', {
    schema: { params: idParams, response: { 200: objectEnvelope(controlResultSchema), 401: errorSchema, 403: errorSchema, 404: errorSchema, 501: errorSchema } },
  }, async (request, reply) => controlChannel(request, reply, options, authenticate, 'start'))

  app.post('/api/v1/channels/:id/logout', {
    schema: { params: idParams, response: { 200: objectEnvelope(controlResultSchema), 401: errorSchema, 403: errorSchema, 404: errorSchema, 501: errorSchema } },
  }, async (request, reply) => controlChannel(request, reply, options, authenticate, 'logout'))

  app.get('/api/v1/conversations', {
    schema: {
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      response: { 200: arrayEnvelope(conversationSchema), 401: errorSchema, 403: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'read')) return
    if (!options.store) return fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    const query = request.query as { limit?: number }
    const conversations = await listRecentConversations(options.store, query.limit ?? 50)
    return ok(reply, conversations.map(projectConversation))
  })

  app.get('/api/v1/conversations/:id/messages', {
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      response: { 200: arrayEnvelope(messageSchema), 401: errorSchema, 403: errorSchema, 404: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'read')) return
    if (!options.store) return fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    const { id } = request.params as { id: string }
    if (!await getConversation(options.store, id)) return fail(reply, 404, 'conversation_not_found', 'Conversation not found.')
    const query = request.query as { limit?: number }
    const messages = await listMessages(options.store, id, query.limit ?? 50)
    return ok(reply, messages.map(projectMessage))
  })

  app.get('/api/v1/conversations/:id/delivery-attempts', {
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      response: { 200: arrayEnvelope(deliveryAttemptSchema), 401: errorSchema, 403: errorSchema, 404: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'read')) return
    if (!options.store) return fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    const { id } = request.params as { id: string }
    if (!await getConversation(options.store, id)) return fail(reply, 404, 'conversation_not_found', 'Conversation not found.')
    const query = request.query as { limit?: number }
    const attempts = await listDeliveryAttempts(options.store, id, query.limit ?? 50)
    return ok(reply, attempts.map((attempt) => ({ ...attempt, attemptedAt: attempt.attemptedAt.toISOString() })))
  })

  app.get('/api/v1/channels/accounts', {
    schema: { response: { 200: arrayEnvelope(channelAccountSchema), 401: errorSchema, 403: errorSchema, 503: errorSchema } },
  }, async (request, reply) => {
    if (!await authorizePolicy(request, reply, authenticate, 'read')) return
    if (!options.store) return fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    const accounts = await listChannelAccounts(options.store)
    return ok(reply, accounts.map(projectChannelAccount))
  })
}

async function sendAndPersist(
  reply: FastifyReply,
  options: MoonskyRoutesOptions,
  channel: MoonskyChannel,
  to: string,
  text: string,
  sendError = true,
): Promise<unknown> {
  if (!options.store) return sendError
    ? fail(reply, 503, 'store_unavailable', 'MOONSKY store is unavailable.')
    : { channel: channel.id, ok: false, status: 'failed' }
  const account = await getChannelAccount(options.store, channel.channelAccountId)
  if (!account || account.provider !== channel.id) return sendError
    ? fail(reply, 503, 'channel_account_unavailable', 'MOONSKY channel account is unavailable.')
    : { channel: channel.id, ok: false, status: 'failed' }
  try {
    const delivery = await channel.send({ to, text })
    if (delivery.status !== 'accepted') {
      if (sendError) return fail(reply, 502, 'delivery_failed', 'Provider delivery failed.')
      return { channel: channel.id, ok: false, status: 'failed' }
    }
    let conversation = await findConversation(options.store, account.id, to)
    if (!conversation) conversation = await createConversation(options.store, { channelAccountId: account.id, externalId: to })
    const message = await appendMessage(options.store, {
      conversationId: conversation.id,
      externalMessageId: delivery.providerMessageId,
      direction: 'outbound',
      body: text,
      status: 'accepted',
    })
    await recordDeliveryAttempt(options.store, {
      messageId: message.id,
      attemptNumber: 1,
      status: 'accepted',
      providerMessageId: delivery.providerMessageId,
    })
    options.events.publish({ type: 'message.outbound', messageId: message.id, provider: channel.id, timestamp: new Date().toISOString() })
    options.events.publish({ type: 'conversation.updated', conversationId: conversation.id, timestamp: new Date().toISOString() })
    const result = { channel: channel.id, to, status: 'accepted', providerMessageId: delivery.providerMessageId, messageId: message.id }
    return sendError ? ok(reply, result) : result
  } catch {
    if (sendError) return fail(reply, 502, 'delivery_failed', 'Provider delivery failed.')
    return { channel: channel.id, ok: false, status: 'failed' }
  }
}

async function controlChannel(
  request: FastifyRequest,
  reply: FastifyReply,
  options: MoonskyRoutesOptions,
  authenticate: ReturnType<typeof createMoonskyAuthenticator>,
  action: 'start' | 'logout',
) {
  if (!await authorizePolicy(request, reply, authenticate, 'admin')) return
  const { id } = request.params as { id: string }
  const channel = options.getChannels().find((candidate) => candidate.id === id)
  if (!channel) return fail(reply, 404, 'channel_not_found', 'Channel not found.')
  const handler = action === 'start' ? channel.start : channel.logout
  if (!handler) return fail(reply, 501, 'operation_unavailable', 'Channel operation is unavailable.')
  try {
    await handler.call(channel)
  } catch {
    return fail(reply, 502, 'channel_operation_failed', 'Channel operation failed.')
  }
  const state = (await channel.status()).state
  options.events.publish({ type: 'channel.state', channelId: channel.id, state, timestamp: new Date().toISOString() })
  return ok(reply, { id: channel.id, state })
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticate: ReturnType<typeof createMoonskyAuthenticator>,
): Promise<MoonskyPrincipal | null> {
  const auth = await authenticate(request)
  if (!auth.ok) {
    fail(reply, auth.status, auth.code, auth.code === 'auth_unavailable' ? 'MOONSKY authentication is unavailable.' : 'Authentication required.')
    return null
  }
  return auth.principal
}

type RoutePolicy = 'admin-or-service-send' | 'admin' | 'read' | 'service'

async function authorizePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticate: ReturnType<typeof createMoonskyAuthenticator>,
  policy: RoutePolicy,
): Promise<MoonskyPrincipal | null> {
  const principal = await authorize(request, reply, authenticate)
  if (!principal) return null

  // The shared service key has two narrow scopes: machine-initiated send, and the
  // channel-registration handshake (id/label/state only). Operator sessions own the
  // control plane; viewers may read the messaging store but never change provider state.
  const isAdmin = principal.kind === 'operator' && principal.role === 'admin'
  const isReader = principal.kind === 'operator'
  const allowed = (policy === 'service' && principal.kind === 'service')
    || (policy === 'admin-or-service-send' && (principal.kind === 'service' || isAdmin))
    || (policy === 'admin' && isAdmin)
    || (policy === 'read' && isReader)
  if (!allowed) {
    fail(reply, 403, 'forbidden', policy === 'service'
      ? 'This operation requires the MOONSKY service credential.'
      : 'This operation requires an administrator session.')
    return null
  }
  return principal
}

function projectChannelAccount(account: ChannelAccount) {
  return {
    id: account.id,
    provider: account.provider,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    status: account.status,
  }
}

function projectConversation(conversation: Conversation) {
  return {
    id: conversation.id,
    channelAccountId: conversation.channelAccountId,
    externalId: conversation.externalId,
    title: conversation.title,
    status: conversation.status,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  }
}

function projectMessage(message: Message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    externalMessageId: message.externalMessageId,
    direction: message.direction,
    senderId: message.senderId,
    body: message.body,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
  }
}

function ok(reply: FastifyReply, data: unknown): FastifyReply {
  return reply.send({ ok: true, data, timestamp: new Date().toISOString() })
}

function fail(reply: FastifyReply, statusCode: number, _code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    ok: false,
    error: { statusCode, message },
    timestamp: new Date().toISOString(),
  })
}
