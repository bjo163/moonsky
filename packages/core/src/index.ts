/** Provider identifiers accepted by the communication contract. */
export type ProviderName = 'whatsapp' | 'telegram'

export type MessageDirection = 'inbound' | 'outbound'

/** Provider-neutral message envelope; timestamps are ISO 8601 strings. */
export interface MessageEnvelope {
  id: string
  channelAccountId: string
  conversationId: string
  providerMessageId: string | null
  direction: MessageDirection
  text: string
  occurredAt: string
}

/** Lifecycle-only provider boundary; transport and persistence stay elsewhere. */
export interface ProviderAdapter {
  readonly provider: ProviderName
  start(): Promise<void>
  stop(): Promise<void>
}

export * from './verify.js'
