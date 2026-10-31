import type { TelegramAdapter } from '@moonsky/telegram'
import type { ConnectionState, IncomingMessage, MessageHandler, WhatsAppStatus } from '@moonsky/whatsapp'
import { appendMessage, createConversation, findConversation } from '@moonsky/store'
import type { MoonskyDatabase } from '@moonsky/store'

export interface MoonskyChannelStatus {
  state: string
  detail?: Record<string, unknown>
}

export interface MoonskySendResult {
  providerMessageId?: string
  status: 'accepted' | 'failed'
  error?: string
}

/** Minimal provider-facing channel boundary consumed by MOONSKY's control plane. */
export interface MoonskyChannel {
  readonly id: string
  readonly label: string
  readonly channelAccountId: string
  status(): MoonskyChannelStatus | Promise<MoonskyChannelStatus>
  send(input: { to: string; text: string }): Promise<MoonskySendResult>
  start?(): Promise<void>
  logout?(): Promise<void>
  on?(event: 'qr', listener: (qr: string) => void): unknown
  off?(event: 'qr', listener: (qr: string) => void): unknown
}

export class DuplicateMoonskyChannelIdError extends Error {
  readonly code = 'MOONSKY_DUPLICATE_CHANNEL_ID'

  constructor(id: string) {
    super(`MOONSKY channel id is already registered: ${id}`)
    this.name = 'DuplicateMoonskyChannelIdError'
  }
}

export class MoonskyChannelRegistry {
  private readonly channels = new Map<string, MoonskyChannel>()

  register(channel: MoonskyChannel): void {
    if (this.channels.has(channel.id)) throw new DuplicateMoonskyChannelIdError(channel.id)
    this.channels.set(channel.id, channel)
  }

  get(id: string): MoonskyChannel | undefined {
    return this.channels.get(id)
  }

  list(): MoonskyChannel[] {
    return [...this.channels.values()]
  }
}

/** Adapt the Telegram transport to the control-plane channel contract. */
export function createTelegramMoonskyChannel(adapter: TelegramAdapter, channelAccountId: string): MoonskyChannel {
  return {
    id: 'telegram',
    label: 'Telegram',
    channelAccountId,
    status: () => ({ state: adapter.status.state }),
    send: async ({ to, text }) => {
      try {
        const result = await adapter.sendText(to, text)
        return { status: result.status, providerMessageId: result.providerMessageId }
      } catch {
        return { status: 'failed' }
      }
    },
    start: () => adapter.start(),
    logout: () => adapter.stop(),
  }
}

/**
 * The control-plane surface MOONSKY needs from the WhatsApp transport. WhatsAppClient
 * satisfies it structurally; tests inject a fake so no Baileys socket is opened.
 */
export interface WhatsAppChannelClient {
  readonly status: WhatsAppStatus
  connect(): Promise<void>
  sendText(to: string, text: string): Promise<string>
  logout(): Promise<void>
  on(event: 'qr', listener: (qr: string) => void): unknown
  off(event: 'qr', listener: (qr: string) => void): unknown
}

/**
 * Map the transport's connection states onto the D18/UI provider vocabulary. `connecting`
 * covers the whole opening handshake: a pairing payload is only available once the transport
 * emits `qr`, so the state alone must not claim that the channel is pairing.
 */
function mapWhatsAppState(state: ConnectionState): string {
  switch (state) {
    case 'open':
      return 'connected'
    case 'connecting':
      return 'connecting'
    default:
      return 'disconnected'
  }
}

/** Adapt the WhatsApp transport to the control-plane channel contract. */
export function createWhatsAppMoonskyChannel(client: WhatsAppChannelClient, channelAccountId: string): MoonskyChannel {
  return {
    id: 'whatsapp',
    label: 'WhatsApp',
    channelAccountId,
    status: () => ({ state: mapWhatsAppState(client.status.state) }),
    send: async ({ to, text }) => {
      try {
        const providerMessageId = await client.sendText(to, text)
        return { status: 'accepted', providerMessageId }
      } catch {
        // The transport may throw a session-not-open error or a provider failure;
        // neither its text nor any credential-bearing detail may reach the caller.
        return { status: 'failed' }
      }
    },
    start: () => client.connect(),
    logout: () => client.logout(),
    on: (event, listener) => client.on(event, listener),
    off: (event, listener) => client.off(event, listener),
  }
}

/**
 * Persist inbound WhatsApp traffic through the D18 store, keyed by the provider account
 * and chat jid, exactly like the Telegram webhook path. Baileys can redeliver, so a
 * duplicate external message id is swallowed rather than raised. No auto-reply and no
 * bot commands: MOONSKY is the messaging surface, not the radio hub.
 */
export function createWhatsAppInboundHandler(
  store: MoonskyDatabase,
  channelAccountId: string,
  onPersisted?: (info: { messageId: string; conversationId: string }) => void,
): MessageHandler {
  return async (message: IncomingMessage) => {
    if (!message.text.trim()) return
    let conversation = await findConversation(store, channelAccountId, message.remoteJid)
    if (!conversation) {
      conversation = await createConversation(store, { channelAccountId, externalId: message.remoteJid })
    }
    try {
      const stored = await appendMessage(store, {
        conversationId: conversation.id,
        externalMessageId: message.id,
        direction: 'inbound',
        senderId: null,
        body: message.text.slice(0, 4096),
        status: 'received',
      })
      onPersisted?.({ messageId: stored.id, conversationId: conversation.id })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if ('code' in candidate && candidate.code === '23505') return true
    candidate = 'cause' in candidate ? candidate.cause : undefined
  }
  return false
}
