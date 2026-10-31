import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { pino } from 'pino'
import { EventEmitter } from 'node:events'
import type {
  ConnectionState,
  IncomingMessage,
  MessageHandler,
  MessageSender,
  WhatsAppClientOptions,
  WhatsAppStatus,
} from './types.js'

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** The small event shape used internally; Baileys' public types stay private. */
interface ConnectionUpdate {
  qrcode?: string
  connection?: string
  me?: { id?: string }
  lastDisconnect?: { error?: { output?: { statusCode?: number } } }
}

type RecordValue = Record<string, unknown>

function recordValue(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function timestampToMs(value: unknown): number {
  let timestamp: number | null = typeof value === 'number' && Number.isFinite(value) ? value : null
  const objectValue = recordValue(value)
  const toNumber = objectValue?.toNumber
  if (timestamp === null && typeof toNumber === 'function') {
    try {
      const converted: unknown = Reflect.apply(toNumber, value, [])
      if (typeof converted === 'number' && Number.isFinite(converted)) timestamp = converted
    } catch {
      timestamp = null
    }
  }
  if (timestamp === null) return Date.now()
  return Math.abs(timestamp) < 1_000_000_000_000 ? timestamp * 1000 : timestamp
}

/** Convert a provider event object to the stable public transport contract. */
export function normalizeIncomingMessage(value: unknown): IncomingMessage | null {
  const raw = recordValue(value)
  const key = recordValue(raw?.key)
  const providerMessage = recordValue(raw?.message)
  const extendedTextMessage = recordValue(providerMessage?.extendedTextMessage)
  const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : ''
  if (!remoteJid) return null

  const conversation = typeof providerMessage?.conversation === 'string' ? providerMessage.conversation : undefined
  const extendedText = typeof extendedTextMessage?.text === 'string' ? extendedTextMessage.text : undefined
  return {
    id: typeof key?.id === 'string' && key.id.length > 0 ? key.id : null,
    remoteJid,
    fromMe: key?.fromMe === true,
    text: conversation ?? extendedText ?? '',
    timestampMs: timestampToMs(raw?.messageTimestamp),
  }
}

/** Normalize an inbound provider event and hand it to consumer-owned behavior. */
export async function dispatchIncomingMessage(
  value: unknown,
  handler: MessageHandler | undefined,
  sender: MessageSender,
  onNormalized?: (message: IncomingMessage) => void,
): Promise<IncomingMessage | null> {
  const message = normalizeIncomingMessage(value)
  if (!message || message.fromMe) return null
  onNormalized?.(message)
  await handler?.(message, sender)
  return message
}

/** A send request made before a transport session is open. */
export class WhatsAppSessionNotOpenError extends Error {
  readonly code = 'WHATSAPP_SESSION_NOT_OPEN'

  constructor() {
    super('WhatsApp session is not open')
    this.name = 'WhatsAppSessionNotOpenError'
  }
}

/** Transport wrapper around a Baileys socket. Emits normalized message events. */
export class WhatsAppClient extends EventEmitter {
  private readonly log = pino({ level: 'silent' })
  private sock: ReturnType<typeof makeWASocket> | null = null
  private _state: ConnectionState = 'disconnected'
  private _qr?: string
  private _jid?: string
  private connecting = false
  private shouldReconnect = true

  constructor(private readonly opts: WhatsAppClientOptions) {
    super()
  }

  get status(): WhatsAppStatus {
    return { state: this._state, qr: this._qr, jid: this._jid }
  }

  /** Establish the WhatsApp connection (idempotent). */
  async connect(): Promise<void> {
    if (this.connecting || this._state === 'open') return
    this.connecting = true
    this.shouldReconnect = true
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir)
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: this.log,
        printQRInTerminal: false,
        browser: ['Transport', 'Chrome', '1.0.0'],
      })

      this.sock.ev.on('creds.update', () => {
        void saveCreds()
      })
      this.sock.ev.on('connection.update', (update) => {
        void this.onConnectionUpdate(update as ConnectionUpdate)
      })
      this.sock.ev.on('messages.upsert', (payload) => {
        this.onMessages(payload.messages as unknown[])
      })

      this.setState('connecting')
    } finally {
      this.connecting = false
    }
  }

  /** Send plain text to a chat jid or phone number. */
  async sendText(to: string, text: string): Promise<string> {
    if (!this.sock || this._state !== 'open') throw new WhatsAppSessionNotOpenError()
    const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`
    const sent = await this.sock.sendMessage(jid, { text })
    return sent?.key?.id ?? ''
  }

  /** End the remote session and stop reconnecting. */
  async logout(): Promise<void> {
    this.shouldReconnect = false
    try {
      await this.sock?.logout()
    } catch {
      /* already offline */
    }
    void this.sock?.end(undefined as never)
    this.sock = null
    this._qr = undefined
    this._jid = undefined
    this.setState('logged-out')
  }

  /** Cleanly stop the socket on service shutdown. */
  async close(): Promise<void> {
    this.shouldReconnect = false
    void this.sock?.end(undefined as never)
    this.sock = null
    this.setState('disconnected')
  }

  private setState(next: ConnectionState): void {
    this._state = next
    this.emit('state', next)
  }

  private async onConnectionUpdate(update: ConnectionUpdate): Promise<void> {
    if (update.qrcode) {
      this._qr = update.qrcode
      this.emit('qr', update.qrcode)
    }
    if (!update.connection) return
    if (update.connection === 'open') {
      this._qr = undefined
      this._jid = update.me?.id ?? undefined
      this.setState('open')
      return
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      this.sock = null
      if (!loggedOut && this.shouldReconnect) {
        this.setState('disconnected')
        await sleep(3000)
        void this.connect()
      } else {
        this.setState(loggedOut ? 'logged-out' : 'disconnected')
      }
      return
    }
    this.setState('connecting')
  }

  private onMessages(messages: unknown[]): void {
    for (const value of messages) {
      void dispatchIncomingMessage(
        value,
        this.opts.messageHandler,
        this,
        (message) => this.emit('message', message),
      ).catch((error: unknown) => this.log.error({ err: error }, 'inbound message handler failed'))
    }
  }
}
