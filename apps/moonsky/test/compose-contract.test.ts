import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const compose = readFileSync(`${ROOT}/docker-compose.yml`, 'utf8').replace(/\r\n/g, '\n')
const dockerfile = readFileSync(`${ROOT}/Dockerfile`, 'utf8').replace(/\r\n/g, '\n')
const envExample = readFileSync(`${ROOT}/.env.example`, 'utf8').replace(/\r\n/g, '\n')
const workflow = readFileSync(`${ROOT}/.github/workflows/ci.yml`, 'utf8').replace(/\r\n/g, '\n')

function serviceBlocks(source: string): Map<string, string> {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^services:\s*$/.test(line))
  assert.ok(start >= 0, 'docker-compose.yml has a services section')

  const blocks = new Map<string, string>()
  let name: string | undefined
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line)
    if (header) {
      if (name) blocks.set(name, body.join('\n'))
      name = header[1]
      body = []
    } else if (/^\S/.test(line)) {
      if (name) blocks.set(name, body.join('\n'))
      break
    } else if (name) body.push(line)
  }
  if (name) blocks.set(name, body.join('\n'))
  return blocks
}

const services = serviceBlocks(compose)

void test('compose: database and application services are healthchecked and ordered', () => {
  assert.deepEqual([...services.keys()].sort(), ['app', 'db'])
  for (const [name, block] of services) {
    assert.match(block, /^ {4}healthcheck:/m, `${name} has a healthcheck`)
  }
  assert.match(services.get('app') ?? '', /db:[\s\S]*?condition: service_healthy/)
})

void test('compose: application is loopback-published and configured from documented defaults', () => {
  const app = services.get('app')
  assert.ok(app, 'app service exists')
  assert.match(app, /dockerfile:\s*Dockerfile/, 'app builds the repository Dockerfile')
  assert.match(app, /127\.0\.0\.1:3005:3005/, 'app is published on loopback only')
  assert.match(app, /DATABASE_URL:\s*postgresql:\/\/moonsky:moonsky@db:5432\/moonsky/)
  assert.match(app, /MOONSKY_SERVICE_KEY:\s*\$\{MOONSKY_SERVICE_KEY:-\}/)
  assert.match(app, /MOONSKY_TELEGRAM_BOT_TOKEN:\s*\$\{MOONSKY_TELEGRAM_BOT_TOKEN:-\}/)
  assert.match(app, /MOONSKY_TELEGRAM_WEBHOOK_SECRET:\s*\$\{MOONSKY_TELEGRAM_WEBHOOK_SECRET:-\}/)
  assert.match(app, /MOONSKY_BOOTSTRAP_LOGIN:\s*\$\{MOONSKY_BOOTSTRAP_LOGIN:-admin\}/)
  const bootstrapPassword = /MOONSKY_BOOTSTRAP_PASSWORD:\s*\$\{MOONSKY_BOOTSTRAP_PASSWORD:-([^}]*)\}/.exec(app)?.[1] ?? ''
  assert.ok(bootstrapPassword.length >= 12, 'the compose bootstrap password satisfies the 12-character minimum')
  assert.match(app, /healthcheck:[\s\S]*?127\.0\.0\.1:3005\/health/)
  assert.doesNotMatch(app, /whatsapp-session|volumes:/, 'provider credentials are not stored in a shared session volume')
})

void test('compose: database is loopback-published and durable', () => {
  const db = services.get('db')
  assert.ok(db, 'db service exists')
  assert.match(db, /postgres:17/)
  assert.match(db, /127\.0\.0\.1:5433:5432/, 'database is published on loopback only')
  assert.match(db, /pg_isready/)
  assert.match(db, /moonsky-db:\/var\/lib\/postgresql\/data/)
  assert.match(compose, /^volumes:\n {2}moonsky-db:/m)
})

void test('Dockerfile builds the workspace and runs the standalone service', () => {
  assert.match(dockerfile, /FROM node:24-slim AS build/)
  assert.match(dockerfile, /FROM node:24-slim AS runtime/)
  assert.match(dockerfile, /pnpm@10\.33\.4/)
  assert.match(dockerfile, /pnpm install --frozen-lockfile/)
  assert.match(dockerfile, /RUN pnpm build/)
  assert.match(dockerfile, /EXPOSE 3005/)
  assert.match(dockerfile, /CMD \["node", "apps\/moonsky\/dist\/index\.js"\]/)
  assert.doesNotMatch(dockerfile, /moonradio|arsy|skylink/i, 'the image does not reach back into the source repository')
})

void test('environment example documents every MOONSKY setting', () => {
  for (const key of [
    'NODE_ENV', 'HOST', 'PORT', 'DATABASE_URL', 'MOONSKY_SERVICE_KEY',
    'MOONSKY_TELEGRAM_BOT_TOKEN', 'MOONSKY_TELEGRAM_WEBHOOK_SECRET',
    'MOONSKY_BOOTSTRAP_LOGIN', 'MOONSKY_BOOTSTRAP_PASSWORD',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'), `.env.example documents ${key}`)
  }
})

void test('CI is one thin install, lint, build, typecheck and test job', () => {
  assert.match(workflow, /node-version:\s*24/)
  assert.match(workflow, /version:\s*10\.33\.4/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  for (const command of ['pnpm lint', 'pnpm build', 'pnpm typecheck', 'pnpm test']) {
    assert.match(workflow, new RegExp(`run: ${command.replace(/ /g, '\\s')}`), `CI runs ${command}`)
  }
  assert.doesNotMatch(workflow, /deploy|publish/i, 'CI does not deploy or publish')
})
