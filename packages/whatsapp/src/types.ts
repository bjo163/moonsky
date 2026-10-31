/** Public state values independent of the WhatsApp library's event types. */
export type ConnectionState = 'disconnected' | 'connecting' | 'open' | 'logged-out'

export interface WhatsAppStatus {
  state: ConnectionState
  /** Raw QR payload, present only while pairing. */
  qr?: string
  /** Connected account jid, present when open. */
  jid?: string
}

/** Stable inbound message shape exposed to provider consumers. */
export interface IncomingMessage {
  id: string | null
  remoteJid: string
  fromMe: boolean
  text: string
  timestampMs: number
}

export interface MessageSender {
  sendText(to: string, text: string): Promise<string>
}

/** Consumer-supplied behavior; the transport package supplies no default commands. */
export type MessageHandler = (
  message: IncomingMessage,
  sender: MessageSender,
) => void | Promise<void>

export interface WhatsAppClientOptions {
  /** Directory where Baileys auth/credentials are persisted. */
  authDir: string
  /** If true, connect when the owning service starts. */
  autoConnect?: boolean
  /** Required by the consumer that owns inbound-message behavior. */
  messageHandler?: MessageHandler
}
