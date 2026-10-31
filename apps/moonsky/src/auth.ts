import { verifySecretToken } from '@moonsky/core'
import { findOperatorBySessionTokenHash } from '@moonsky/store'
import type { MoonskyDatabase, OperatorRole } from '@moonsky/store'
import type { FastifyRequest } from 'fastify'
import { hashToken } from './session.js'

const TOKEN_LIMIT = 4096

export interface MoonskyPrincipal {
  kind: 'service' | 'operator'
  login?: string
  role?: OperatorRole
}

export type AuthResult =
  | { ok: true; principal: MoonskyPrincipal }
  | { ok: false; status: 401 | 503; code: 'unauthorized' | 'auth_unavailable' }

export interface AuthOptions {
  db?: MoonskyDatabase
  serviceKey: string
  now?: () => number
}

export function createMoonskyAuthenticator(options: AuthOptions) {
  const now = options.now ?? Date.now

  async function authenticateCredentials(credentials: {
    serviceKey?: string
    authorization?: string
  }): Promise<AuthResult> {
    if (credentials.serviceKey !== undefined) {
      return options.serviceKey && verifySecretToken(credentials.serviceKey, options.serviceKey)
        ? { ok: true, principal: { kind: 'service' } }
        : { ok: false, status: 401, code: 'unauthorized' }
    }

    const token = credentials.authorization?.startsWith('Bearer ')
      ? credentials.authorization.slice(7).trim()
      : ''
    if (!token || token.length > TOKEN_LIMIT) return { ok: false, status: 401, code: 'unauthorized' }
    if (!options.db) return { ok: false, status: 503, code: 'auth_unavailable' }

    const operator = await findOperatorBySessionTokenHash(options.db, hashToken(token), new Date(now()))
    if (!operator) return { ok: false, status: 401, code: 'unauthorized' }
    return { ok: true, principal: { kind: 'operator', login: operator.login, role: operator.role } }
  }

  async function authenticate(request: FastifyRequest): Promise<AuthResult> {
    const serviceHeader = request.headers['x-moonsky-key']
    if (serviceHeader !== undefined) {
      if (Array.isArray(serviceHeader)) return { ok: false, status: 401, code: 'unauthorized' }
      return authenticateCredentials({ serviceKey: serviceHeader })
    }
    const authorization = request.headers.authorization
    if (Array.isArray(authorization)) return { ok: false, status: 401, code: 'unauthorized' }
    return authenticateCredentials({ authorization })
  }

  return Object.assign(authenticate, {
    authenticateCredentials,
    authenticateRequest: authenticate,
  })
}

export function createCredentialAuthenticator(options: AuthOptions) {
  const authenticateRequest = createMoonskyAuthenticator(options)
  return {
    authenticateRequest,
    authenticateCredentials: async (credentials: { serviceKey?: string; authorization?: string }) =>
      // WebSocket auth uses the same resolver as REST without cookies or query tokens.
      authenticateRequest.authenticateCredentials(credentials),
  }
}
