import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { TelegramAdapter } from '../src/index.js'
import {
  createChannelAccount,
  createMoonskyStore,
  listMessages,
  migrateMoonskyStore,
} from '@moonsky/store'
import type { MoonskyDatabase } from '@moonsky/store'

const secret = 'synthetic-telegram-webhook-secret'
const databaseUrl = process.env.DATABASE_URL

void test('Telegram rejects missing/incorrect secret before parsing a webhook body', async () => {
  const adapter = new TelegramAdapter({
    botToken: 'synthetic-token-never-used',
    webhookSecret: secret,
    externalAccountId: 'synthetic-bot',
    authRef: 'secret://test/telegram-bot',
    store: {} as MoonskyDatabase,
    api: { sendMessage: async () => ({ message_id: 1 }) } as never,
  })

  assert.deepEqual(await adapter.handleWebhook(undefined, '{not-json'), { statusCode: 401, code: 'unauthorized' })
  assert.deepEqual(await adapter.handleWebhook('wrong-secret', '{not-json'), { statusCode: 401, code: 'unauthorized' })
  assert.equal(JSON.stringify(await adapter.handleWebhook('wrong-secret', '{not-json')).includes(secret), false)
  assert.deepEqual(await adapter.sendText('42', 'synthetic outbound message'), {
    status: 'accepted',
    providerMessageId: '1',
  })
  await adapter.stop()
  assert.deepEqual(adapter.status, { state: 'stopped' })
  await assert.rejects(adapter.sendText('42', 'after stop'), /adapter is stopped/)
})

void test('Telegram accepts a verified update once and persists a normalized D18 message', { skip: !databaseUrl }, async (t) => {
  assert.ok(databaseUrl)
  const url = new URL(databaseUrl)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'database integration test is local-only')

  const store = createMoonskyStore(databaseUrl)
  await migrateMoonskyStore(store)
  const externalAccountId = `m38-10-test-${randomUUID()}`
  const account = await createChannelAccount(store.db, {
    provider: 'telegram',
    externalAccountId,
    authRef: 'secret://test/telegram-bot',
    status: 'connected',
  })
  t.after(async () => {
    await store.client`DELETE FROM moonsky.channel_accounts WHERE id = ${account.id}`
    await store.client.end({ timeout: 5 })
  })

  const adapter = new TelegramAdapter({
    botToken: 'synthetic-token-never-used',
    webhookSecret: secret,
    externalAccountId,
    authRef: 'secret://test/telegram-bot',
    store: store.db,
    api: { sendMessage: async () => ({ message_id: 1 }) } as never,
  })
  const update = {
    update_id: Math.floor(Math.random() * 2_000_000_000),
    message: {
      message_id: 72,
      date: 1_798_000_000,
      chat: { id: -100123456789, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Fixture' },
      text: 'synthetic verified message',
    },
  }
  const body = JSON.stringify(update)

  assert.deepEqual(await adapter.handleWebhook('wrong-secret', body), { statusCode: 401, code: 'unauthorized' })
  const accepted = await adapter.handleWebhook(secret, body)
  assert.equal(accepted.statusCode, 202)
  if (accepted.statusCode !== 202) return

  const replay = await adapter.handleWebhook(secret, body)
  assert.deepEqual(replay, { statusCode: 409, code: 'duplicate_update' })
  const conversation = await store.client`SELECT id FROM moonsky.conversations WHERE channel_account_id = ${account.id} AND external_id = ${String(update.message.chat.id)}`
  assert.equal(conversation.length, 1)
  const storedConversation = conversation[0]
  assert.ok(storedConversation)
  const messages = await listMessages(store.db, String(storedConversation.id))
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.externalMessageId, String(update.update_id))
  assert.equal(messages[0]?.body, 'synthetic verified message')
  assert.equal(messages[0]?.direction, 'inbound')
})
