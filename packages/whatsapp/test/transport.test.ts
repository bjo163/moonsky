import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dispatchIncomingMessage,
  normalizeIncomingMessage,
  WhatsAppClient,
  WhatsAppSessionNotOpenError,
} from '../src/index.js'

test('normalizes a synthetic provider message before invoking consumer behavior', async () => {
  const seen: unknown[] = []
  const result = await dispatchIncomingMessage(
    {
      key: { remoteJid: '15551234567@s.whatsapp.net', id: 'synthetic-1', fromMe: false },
      message: { extendedTextMessage: { text: 'ping' } },
      messageTimestamp: 1_700_000_000,
    },
    async (message, sender) => {
      seen.push(message)
      await sender.sendText(message.remoteJid, message.text)
    },
    { sendText: async (to, text) => `${to}:${text}` },
    (message) => seen.push({ normalizedEvent: message }),
  )

  assert.deepEqual(result, {
    id: 'synthetic-1',
    remoteJid: '15551234567@s.whatsapp.net',
    fromMe: false,
    text: 'ping',
    timestampMs: 1_700_000_000_000,
  })
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0], { normalizedEvent: result })
  assert.deepEqual(seen[1], result)
})

test('sendText fails clearly while no session is open', async () => {
  const client = new WhatsAppClient({ authDir: 'unused-synthetic-auth-path' })
  await assert.rejects(client.sendText('15551234567', 'hello'), (error: unknown) => {
    assert.ok(error instanceof WhatsAppSessionNotOpenError)
    assert.equal(error.code, 'WHATSAPP_SESSION_NOT_OPEN')
    assert.equal(error.message, 'WhatsApp session is not open')
    return true
  })
})

test('drops self messages and provider payloads without a destination', () => {
  assert.equal(normalizeIncomingMessage({ key: { remoteJid: 'chat', fromMe: true }, message: { conversation: 'self' } })?.fromMe, true)
  assert.equal(normalizeIncomingMessage({ key: { fromMe: false }, message: { conversation: 'missing destination' } }), null)
})
