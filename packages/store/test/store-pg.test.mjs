import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  appendMessage,
  createChannelAccount,
  createConversation,
  createMoonskyStore,
  dropMoonskySchema,
  listMessages,
  migrateMoonskyStore,
} from '../dist/index.js'

const databaseUrl = process.env.DATABASE_URL

test('MOONSKY store migrates up, bounds repository reads, and rolls its schema down', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'database integration test is local-only')

  const store = createMoonskyStore(databaseUrl)
  try {
    const [existing] = await store.client`SELECT to_regnamespace('moonsky') IS NOT NULL AS exists`
    assert.equal(existing?.exists, false, 'refusing to replace an existing moonsky schema')

    await migrateMoonskyStore(store)

    const account = await createChannelAccount(store.db, {
      provider: 'whatsapp',
      externalAccountId: `test-${randomUUID()}`,
      authRef: 'vault://moonsky/test-only-reference',
    })
    assert.equal(account.authRef, 'vault://moonsky/test-only-reference')

    const conversation = await createConversation(store.db, {
      channelAccountId: account.id,
      externalId: `conversation-${randomUUID()}`,
    })
    const message = await appendMessage(store.db, {
      conversationId: conversation.id,
      direction: 'inbound',
      body: 'schema migration verification',
    })

    const rows = await listMessages(store.db, conversation.id, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, message.id)
    await assert.rejects(() => listMessages(store.db, conversation.id, 101), RangeError)
  } finally {
    await dropMoonskySchema(store.client)
    await store.client.end({ timeout: 5 })
  }

  const verifier = createMoonskyStore(databaseUrl)
  try {
    const [afterRollback] = await verifier.client`SELECT to_regnamespace('moonsky') IS NULL AS absent`
    assert.equal(afterRollback?.absent, true)
  } finally {
    await verifier.client.end({ timeout: 5 })
  }
})
