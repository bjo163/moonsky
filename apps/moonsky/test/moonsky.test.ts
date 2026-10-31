import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { createMoonskyServer } from '../src/server.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

const defaults = {
  nodeEnv: 'development',
  host: '127.0.0.1',
  port: 3005,
  databaseUrl: '',
  serviceKey: '',
  telegramBotToken: '',
  telegramWebhookSecret: '',
  whatsappAuthDir: '',
  bootstrapLogin: 'admin',
  bootstrapPassword: '',
} as const

void test('MOONSKY accepts the default, environment and command-line ports', () => {
  assert.deepEqual(parseConfig({}), defaults)
  assert.deepEqual(parseConfig({ HOST: '0.0.0.0', PORT: '3015' }), { ...defaults, host: '0.0.0.0', port: 3015 })
  assert.deepEqual(parseConfig({ PORT: '3015' }, ['--port', '3025']), { ...defaults, port: 3025 })
  assert.deepEqual(parseConfig({}, ['--port=3035']), { ...defaults, port: 3035 })
})

void test('MOONSKY rejects invalid ports with a concise configuration error', () => {
  for (const port of ['abc', '0', '65536', '2.5', '']) {
    assert.throws(
      () => parseConfig({ PORT: port }),
      /Invalid MOONSKY configuration: PORT:/,
    )
  }
  assert.throws(() => parseConfig({}, ['--port']), /--port requires an integer/)
})

void test('MOONSKY validates service, webhook, bootstrap and production configuration', () => {
  assert.throws(() => parseConfig({ MOONSKY_SERVICE_KEY: 'short' }), /at least 32 characters/)
  assert.throws(() => parseConfig({ MOONSKY_SERVICE_KEY: 'x'.repeat(257) }), /256 characters/)
  assert.throws(() => parseConfig({ MOONSKY_TELEGRAM_BOT_TOKEN: 'synthetic-token' }), /configured together/)
  assert.throws(() => parseConfig({
    MOONSKY_TELEGRAM_BOT_TOKEN: 'synthetic-token',
    MOONSKY_TELEGRAM_WEBHOOK_SECRET: 'short',
  }), /webhook secret must be at least 32 characters/)
  assert.throws(() => parseConfig({ MOONSKY_BOOTSTRAP_PASSWORD: 'short' }), /at least 12 characters/)
  assert.throws(() => parseConfig({ NODE_ENV: 'production' }), /production configuration/)
  assert.doesNotThrow(() => parseConfig({
    MOONSKY_SERVICE_KEY: 'synthetic-service-key-value-123456',
    MOONSKY_TELEGRAM_BOT_TOKEN: 'synthetic-token',
    MOONSKY_TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret-value-123456',
    MOONSKY_BOOTSTRAP_PASSWORD: 'synthetic-bootstrap-password',
  }))
})

void test('MOONSKY parses the WhatsApp session directory and defaults it absent', () => {
  assert.equal(parseConfig({}).whatsappAuthDir, '')
  assert.equal(parseConfig({ MOONSKY_WHATSAPP_AUTH_DIR: 'whatsapp-session' }).whatsappAuthDir, 'whatsapp-session')
  assert.equal(parseConfig({ MOONSKY_WHATSAPP_AUTH_DIR: '  /var/lib/moonsky/wa  ' }).whatsappAuthDir, '/var/lib/moonsky/wa')
  // WhatsApp is a single explicit path; enabling it without Telegram or a store is a
  // runtime concern (the composition root refuses it), never a configuration-time throw.
  assert.doesNotThrow(() => parseConfig({ MOONSKY_WHATSAPP_AUTH_DIR: 'whatsapp-session' }))
})

void test('health endpoint identifies MOONSKY without implying configured providers', async () => {
  const app = createMoonskyServer(parseConfig({}))
  try {
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok', app: 'moonsky', port: 3005 })
    assert.equal(response.body.includes('provider'), false)
    const routes = app.printRoutes()
    assert.match(routes, /send \(POST\)/)
    assert.match(routes, /webhooks\//)
    assert.match(routes, /health \(GET, HEAD\)/)
    assert.match(routes, /ws \(GET, HEAD\)/)
  } finally {
    await app.close()
  }
})

void test('MOONSKY declares its API, store, transport and local UI dependencies', () => {
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    '@fastify/websocket',
    '@moonsky/core',
    '@moonsky/store',
    '@moonsky/telegram',
    '@moonsky/whatsapp',
    '@radix-ui/react-dialog',
    '@radix-ui/react-slot',
    'class-variance-authority',
    'clsx',
    'fastify',
    'react',
    'react-dom',
    'tailwind-merge',
    'zod',
  ])
})
