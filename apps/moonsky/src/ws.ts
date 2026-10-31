import { EventEmitter } from 'node:events'
import type { FastifyInstance } from 'fastify'
import { createCredentialAuthenticator } from './auth.js'
import type { AuthOptions } from './auth.js'
import type { MoonskyEvent } from './events.js'

const FIRST_FRAME_TIMEOUT_MS = 5_000

export class MoonskyEventBus extends EventEmitter {
  publish(event: MoonskyEvent): void {
    this.emit('event', event)
  }
}

export function registerWebSocketRoute(
  app: FastifyInstance,
  authOptions: AuthOptions,
  events: MoonskyEventBus,
): void {
  const authenticate = createCredentialAuthenticator(authOptions)

  app.get('/ws', { websocket: true }, (socket) => {
    let closed = false
    const timeout = setTimeout(() => {
      if (!closed && socket.readyState === 1) socket.close(1008, 'Authentication required')
    }, FIRST_FRAME_TIMEOUT_MS)
    const onEvent = (event: MoonskyEvent) => {
      if (closed || socket.readyState !== 1) return
      socket.send(JSON.stringify(event))
    }
    const onClose = () => {
      closed = true
      clearTimeout(timeout)
      events.off('event', onEvent)
    }

    socket.once('close', onClose)
    socket.once('message', (raw: unknown) => {
      void (async () => {
        let frame: unknown
        try {
          frame = JSON.parse(messageText(raw)) as unknown
        } catch {
          socket.close(1008, 'Invalid authentication frame')
          return
        }
        if (!isAuthFrame(frame)) {
          socket.close(1008, 'Invalid authentication frame')
          return
        }
        const result = await authenticate.authenticateCredentials(frame)
        if (closed || socket.readyState !== 1) return
        if (!result.ok) {
          socket.send(JSON.stringify({ type: 'auth', ok: false, error: result.code }))
          socket.close(1008, 'Authentication failed')
          return
        }
        if (result.principal.kind !== 'operator' || result.principal.role !== 'admin') {
          socket.send(JSON.stringify({ type: 'auth', ok: false, error: 'forbidden' }))
          socket.close(1008, 'Administrator session required')
          return
        }
        clearTimeout(timeout)
        events.on('event', onEvent)
        socket.send(JSON.stringify({ type: 'auth', ok: true }))
      })().catch(() => {
        if (!closed && socket.readyState === 1) socket.close(1011, 'Authentication unavailable')
      })
    })
  })
}

function isAuthFrame(value: unknown): value is { type: 'auth'; serviceKey?: string; authorization?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return frame.type === 'auth'
    && (frame.serviceKey === undefined || typeof frame.serviceKey === 'string')
    && (frame.authorization === undefined || typeof frame.authorization === 'string')
    && (typeof frame.serviceKey === 'string' || typeof frame.authorization === 'string')
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  return ''
}
