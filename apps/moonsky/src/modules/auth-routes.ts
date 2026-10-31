import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  createOperatorSession,
  deleteExpiredOperatorSessions,
  deleteOperatorSession,
  findOperatorByLogin,
} from '@moonsky/store'
import type { MoonskyDatabase } from '@moonsky/store'
import type { AuthOptions, MoonskyPrincipal } from '../auth.js'
import { createMoonskyAuthenticator } from '../auth.js'
import { hashPassword, hashToken, newSessionToken, SESSION_TTL_MS, verifyPassword } from '../session.js'

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

const loginResponseSchema = {
  type: 'object',
  required: ['ok', 'data', 'timestamp'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    data: {
      type: 'object',
      required: ['token', 'expiresAt', 'operator'],
      additionalProperties: false,
      properties: {
        token: { type: 'string' },
        expiresAt: { type: 'string' },
        operator: {
          type: 'object',
          required: ['login', 'role'],
          additionalProperties: false,
          properties: { login: { type: 'string' }, role: { type: 'string' } },
        },
      },
    },
    timestamp: { type: 'string' },
  },
} as const

const meResponseSchema = {
  type: 'object',
  required: ['ok', 'data', 'timestamp'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    data: {
      type: 'object',
      required: ['login', 'role'],
      additionalProperties: false,
      properties: { login: { type: 'string' }, role: { type: 'string' } },
    },
    timestamp: { type: 'string' },
  },
} as const

const WINDOW_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5
const MAX_TRACKED_KEYS = 1_000
const DUMMY_HASH = await hashPassword('moonsky-timing-equalizer')

export interface AuthRoutesOptions extends AuthOptions {
  db?: MoonskyDatabase
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const authenticate = createMoonskyAuthenticator(options)
  const attempts = new Map<string, { count: number; resetAt: number }>()
  const now = options.now ?? Date.now

  function throttleKey(request: FastifyRequest, login: string): string {
    return `${request.ip}:${login}`
  }

  function isThrottled(key: string): boolean {
    const entry = attempts.get(key)
    if (!entry) return false
    if (entry.resetAt <= now()) {
      attempts.delete(key)
      return false
    }
    return entry.count >= MAX_ATTEMPTS
  }

  function recordFailure(key: string): void {
    if (attempts.size >= MAX_TRACKED_KEYS) {
      for (const [candidate, entry] of attempts) {
        if (entry.resetAt <= now()) attempts.delete(candidate)
      }
    }
    const entry = attempts.get(key)
    if (!entry || entry.resetAt <= now()) {
      attempts.set(key, { count: 1, resetAt: now() + WINDOW_MS })
      return
    }
    entry.count += 1
  }

  app.post('/api/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        additionalProperties: false,
        properties: {
          login: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
      response: { 200: loginResponseSchema, 401: errorSchema, 429: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!options.db) return fail(reply, 503, 'Store is unavailable.')
    const { login, password } = request.body as { login: string; password: string }
    const key = throttleKey(request, login)
    if (isThrottled(key)) return fail(reply, 429, 'Too many sign-in attempts. Try again later.')

    const operator = await findOperatorByLogin(options.db, login)
    const matches = await verifyPassword(password, operator?.passwordHash ?? DUMMY_HASH)
    if (!operator || operator.disabled || !matches) {
      recordFailure(key)
      return fail(reply, 401, 'Invalid credentials.')
    }

    attempts.delete(key)
    await deleteExpiredOperatorSessions(options.db)
    const token = newSessionToken()
    const expiresAt = new Date(now() + SESSION_TTL_MS)
    await createOperatorSession(options.db, {
      operatorId: operator.id,
      tokenHash: hashToken(token),
      expiresAt,
    })
    return reply.send({
      ok: true,
      data: { token, expiresAt: expiresAt.toISOString(), operator: { login: operator.login, role: operator.role } },
      timestamp: new Date().toISOString(),
    })
  })

  app.post('/api/v1/auth/logout', {
    schema: { response: { 204: { type: 'null' }, 401: errorSchema, 403: errorSchema, 503: errorSchema } },
  }, async (request, reply) => {
    const principal = await requireOperator(request, reply, authenticate)
    if (!principal || !options.db) return
    const token = bearerToken(request)
    if (!token) return fail(reply, 401, 'Authentication required.')
    await deleteOperatorSession(options.db, hashToken(token))
    return reply.code(204).send()
  })

  app.get('/api/v1/auth/me', {
    schema: { response: { 200: meResponseSchema, 401: errorSchema, 403: errorSchema, 503: errorSchema } },
  }, async (request, reply) => {
    const principal = await requireOperator(request, reply, authenticate)
    if (!principal) return
    return reply.send({
      ok: true,
      data: { login: principal.login, role: principal.role },
      timestamp: new Date().toISOString(),
    })
  })
}

async function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticate: ReturnType<typeof createMoonskyAuthenticator>,
): Promise<MoonskyPrincipal | null> {
  const result = await authenticate(request)
  if (!result.ok) {
    fail(reply, result.status, result.code === 'auth_unavailable'
      ? 'MOONSKY authentication is unavailable.'
      : 'Authentication required.')
    return null
  }
  if (result.principal.kind !== 'operator') {
    fail(reply, 403, 'This operation requires an operator session.')
    return null
  }
  return result.principal
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return ''
  return authorization.slice(7).trim()
}

function fail(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send({
    ok: false,
    error: { statusCode, message },
    timestamp: new Date().toISOString(),
  })
}
