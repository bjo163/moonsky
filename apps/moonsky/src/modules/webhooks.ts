import type { FastifyInstance } from 'fastify'
import { verifySecretToken } from '@moonsky/core'
import type { TelegramAdapter } from '@moonsky/telegram'
import type { MoonskyEventBus } from '../ws.js'

const errorSchema = {
  type: 'object', required: ['ok', 'error', 'timestamp'],
  properties: {
    ok: { const: false },
    error: { type: 'object', required: ['statusCode', 'message'], properties: { statusCode: { type: 'integer' }, message: { type: 'string' } } },
    timestamp: { type: 'string' },
  },
} as const

export interface WebhookOptions {
  telegramSecret: string
  telegram?: TelegramAdapter
  events: MoonskyEventBus
}

export function registerWebhookRoutes(app: FastifyInstance, options: WebhookOptions): void {
  // Encapsulate the raw JSON parser to this webhook route. The onRequest hook
  // verifies the Telegram secret before Fastify invokes any body parser.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    scope.post('/api/v1/webhooks/:provider', {
      schema: {
        params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', minLength: 1, maxLength: 32 } } },
        response: { 202: { type: 'object', additionalProperties: true }, 204: { type: 'null' }, 400: errorSchema, 401: errorSchema, 404: errorSchema },
      },
      onRequest: async (request, reply) => {
        const { provider } = request.params as { provider: string }
        if (provider !== 'telegram' || !options.telegram) {
          return reply.code(404).send({ ok: false, error: { statusCode: 404, message: 'Provider webhook not found.' }, timestamp: new Date().toISOString() })
        }
        const header = request.headers['x-telegram-bot-api-secret-token']
        if (Array.isArray(header) || !verifySecretToken(header, options.telegramSecret)) {
          return reply.code(401).send({ ok: false, error: { statusCode: 401, message: 'Authentication required.' }, timestamp: new Date().toISOString() })
        }
      },
    }, async (request, reply) => {
      if (!options.telegram) {
        return reply.code(404).send({ ok: false, error: { statusCode: 404, message: 'Provider webhook not found.' }, timestamp: new Date().toISOString() })
      }
      const header = request.headers['x-telegram-bot-api-secret-token']
      const result = await options.telegram.handleWebhook(
        typeof header === 'string' ? header : undefined,
        request.body as Buffer,
      )
      if (result.statusCode === 401) {
        return reply.code(401).send({ ok: false, error: { statusCode: 401, message: 'Authentication required.' }, timestamp: new Date().toISOString() })
      }
      if (result.statusCode === 400) {
        return reply.code(400).send({ ok: false, error: { statusCode: 400, message: 'Invalid provider update.' }, timestamp: new Date().toISOString() })
      }
      if (result.statusCode === 409) {
        return reply.code(202).send({ ok: true, data: { duplicate: true }, timestamp: new Date().toISOString() })
      }
      if (result.statusCode === 204) return reply.code(204).send()

      options.events.publish({
        type: 'message.inbound',
        messageId: result.messageId,
        provider: 'telegram',
        timestamp: new Date().toISOString(),
      })
      options.events.publish({
        type: 'conversation.updated',
        conversationId: result.conversationId,
        timestamp: new Date().toISOString(),
      })
      return reply.code(202).send({ ok: true, data: { messageId: result.messageId }, timestamp: new Date().toISOString() })
    })
  })
}
