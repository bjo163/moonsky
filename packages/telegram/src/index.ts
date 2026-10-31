import { Bot } from 'grammy'
import type { Api } from 'grammy'
import { verifySecretToken } from '@moonsky/core'
import type { ProviderAdapter } from '@moonsky/core'
import {
  appendMessage,
  createChannelAccount,
  createConversation,
  findChannelAccount,
  findConversation,
} from '@moonsky/store'
import type { MoonskyDatabase } from '@moonsky/store'

export interface TelegramWebhookOptions {
  /** Telegram Bot API token. Keep in the secret environment; never in MOONSKY rows. */
  botToken: string
  /** Telegram's setWebhook secret_token, not the bot token. */
  webhookSecret: string
  /** Provider account identity and secret reference stored by the MOONSKY store. */
  externalAccountId: string
  authRef: string
  store: MoonskyDatabase
  /** Test seam; production defaults to the grammY Bot API client. */
  api?: Pick<Api, 'sendMessage'>
}

export interface TelegramInboundMessage {
  updateId: number
  chatId: string
  senderId: string | null
  text: string
}

export type TelegramWebhookResult =
  | { statusCode: 202; messageId: string; conversationId: string }
  | { statusCode: 204 }
  | { statusCode: 400; code: 'invalid_update' }
  | { statusCode: 401; code: 'unauthorized' }
  | { statusCode: 409; code: 'duplicate_update' }

/** Transport adapter. The MOONSKY service owns routing, secret provisioning, and lifecycle. */
export class TelegramAdapter implements ProviderAdapter {
  readonly provider = 'telegram' as const
  private readonly api: Pick<Api, 'sendMessage'>
  private state: 'configured' | 'stopped' = 'configured'

  constructor(private readonly options: TelegramWebhookOptions) {
    this.api = options.api ?? new Bot(options.botToken).api
  }

  /** grammY's Bot API transport is stateless; start performs no polling or network call. */
  async start(): Promise<void> {
    this.state = 'configured'
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
  }

  get status(): { state: 'configured' | 'stopped' } {
    return { state: this.state }
  }

  /** Send text through grammY's Bot API client and return the provider message id. */
  async sendText(chatId: string, text: string): Promise<{ status: 'accepted'; providerMessageId: string }> {
    if (this.state === 'stopped') throw new Error('Telegram adapter is stopped')
    try {
      const sent = await this.api.sendMessage(chatId, text)
      return { status: 'accepted', providerMessageId: String(sent.message_id) }
    } catch {
      // Do not expose grammY request details, which could include credential-bearing URLs.
      throw new Error('Telegram message delivery failed')
    }
  }

  /**
   * Verify Telegram's secret-token header before parsing untrusted JSON, then persist
   * a normalized text message through the MOONSKY store owner. Telegram does not sign the
   * request body; the unique external message id rejects redelivery/replay.
   */
  async handleWebhook(secretHeader: string | undefined, rawBody: Uint8Array | string): Promise<TelegramWebhookResult> {
    if (!verifySecretToken(secretHeader, this.options.webhookSecret)) {
      return { statusCode: 401, code: 'unauthorized' }
    }

    let update: unknown
    try {
      const bodyText = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')
      update = JSON.parse(bodyText) as unknown
    } catch {
      return { statusCode: 400, code: 'invalid_update' }
    }

    const message = normalizeTelegramUpdate(update)
    if (!message) return { statusCode: 204 }

    let account = await findChannelAccount(this.options.store, 'telegram', this.options.externalAccountId)
    if (!account) {
      account = await createChannelAccount(this.options.store, {
        provider: 'telegram',
        externalAccountId: this.options.externalAccountId,
        authRef: this.options.authRef,
        status: 'connected',
      })
    }

    let conversation = await findConversation(this.options.store, account.id, message.chatId)
    if (!conversation) {
      conversation = await createConversation(this.options.store, {
        channelAccountId: account.id,
        externalId: message.chatId,
      })
    }

    try {
      const stored = await appendMessage(this.options.store, {
        conversationId: conversation.id,
        externalMessageId: String(message.updateId),
        direction: 'inbound',
        senderId: message.senderId,
        body: message.text,
        status: 'received',
      })
      return { statusCode: 202, messageId: stored.id, conversationId: conversation.id }
    } catch (error) {
      if (isUniqueViolation(error)) return { statusCode: 409, code: 'duplicate_update' }
      throw error
    }
  }
}

function normalizeTelegramUpdate(value: unknown): TelegramInboundMessage | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.update_id) || (value.update_id as number) < 0) return null
  const message = isRecord(value.message) ? value.message : null
  const chat = message && isRecord(message.chat) ? message.chat : null
  const from = message && isRecord(message.from) ? message.from : null
  if (!message || !chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) return null

  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
  if (!text.trim()) return null
  return {
    updateId: value.update_id as number,
    chatId: String(chat.id),
    senderId: from && (typeof from.id === 'number' || typeof from.id === 'string') ? String(from.id) : null,
    text: text.slice(0, 4096),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if ('code' in candidate && candidate.code === '23505') return true
    candidate = 'cause' in candidate ? candidate.cause : undefined
  }
  return false
}
