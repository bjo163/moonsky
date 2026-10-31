import type { TelegramAdapter } from '@moonsky/telegram'

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
