import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import type { FastifyServerOptions } from 'fastify'
import type { MoonskyConfig } from './config.js'
import { MoonskyChannelRegistry } from './channels.js'
import { registerMoonskyRoutes } from './modules/routes.js'
import { registerAuthRoutes } from './modules/auth-routes.js'
import { registerWebhookRoutes } from './modules/webhooks.js'
import type { MoonskyDatabase } from '@moonsky/store'
import type { TelegramAdapter } from '@moonsky/telegram'
import { MoonskyEventBus, registerWebSocketRoute } from './ws.js'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export interface MoonskyServerOptions {
  store?: MoonskyDatabase
  channels?: MoonskyChannelRegistry
  telegram?: TelegramAdapter
  events?: MoonskyEventBus
  now?: () => number
  /** Off in production by default; injectable so log hygiene is testable. */
  logger?: FastifyServerOptions['logger']
}

export function createMoonskyServer(config: MoonskyConfig, options: MoonskyServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false })

  const channels = options.channels ?? new MoonskyChannelRegistry()
  const events = options.events ?? new MoonskyEventBus()
  const authOptions = {
    db: options.store,
    serviceKey: config.serviceKey,
    now: options.now,
  }

  registerAuthRoutes(app, authOptions)
  registerMoonskyRoutes(app, {
    ...authOptions,
    store: options.store,
    getChannels: () => channels.list(),
    events,
  })
  registerWebhookRoutes(app, {
    telegramSecret: config.telegramWebhookSecret,
    telegram: options.telegram,
    events,
  })
  app.register(async (scope) => {
    await scope.register(websocket)
    registerWebSocketRoute(scope, authOptions, events)
  })

  const qrListeners = channels.list().flatMap((channel) => {
    if (!channel.on) return []
    const listener = (qr: string) => events.publish({
      type: 'channel.qr', channelId: channel.id, qr, timestamp: new Date().toISOString(),
    })
    channel.on('qr', listener)
    return [{ channel, listener }]
  })
  app.addHook('onClose', async () => {
    for (const { channel, listener } of qrListeners) channel.off?.('qr', listener)
  })

  app.setErrorHandler((error, _request, reply) => {
    const validationError = isValidationError(error)
    const statusCode = validationError ? 400 : 500
    const message = validationError ? 'Invalid request.' : 'Request failed.'
    return reply.code(statusCode).send({
      ok: false,
      error: { statusCode, message },
      timestamp: new Date().toISOString(),
    })
  })

  app.get('/health', async () => ({
    status: 'ok',
    app: 'moonsky',
    port: config.port,
  }))

  // The operator UI is part of this service, so expose only its Vite entry
  // document and allowlisted assets, with containment checks; API routes remain
  // registered above and own their paths.
  const clientRoot = resolve(import.meta.dirname, '../dist/client')
  app.get('/', async (_request, reply) => {
    try {
      const html = await readFile(resolve(clientRoot, 'index.html'), 'utf8')
      return reply.type('text/html; charset=utf-8').send(html)
    } catch {
      return reply.code(503).type('text/plain; charset=utf-8').send('MOONSKY operator UI is not built. Run the MOONSKY build command.')
    }
  })
  app.get('/assets/*', async (request, reply) => {
    const assetPath = (request.params as { '*': string })['*']
    const assetRoot = resolve(clientRoot, 'assets')
    const filePath = resolve(assetRoot, assetPath)
    if (!filePath.startsWith(`${assetRoot}${sep}`)) return reply.code(404).send()
    const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
    const type = types[extname(filePath)]
    if (!type) return reply.code(404).send()
    try {
      if (!(await stat(filePath)).isFile()) return reply.code(404).send()
      return reply.type(type).header('cache-control', 'public, max-age=31536000, immutable').send(await readFile(filePath))
    } catch {
      return reply.code(404).send()
    }
  })

  return app
}

function isValidationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'validation' in error && Array.isArray(error.validation)
}
