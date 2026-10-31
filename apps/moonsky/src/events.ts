export type MoonskyEvent =
  | { type: 'message.inbound'; messageId: string; provider: string; timestamp: string }
  | { type: 'message.outbound'; messageId: string; provider: string; timestamp: string }
  | { type: 'channel.state'; channelId: string; state: string; timestamp: string }
  | { type: 'channel.qr'; channelId: string; qr: string; timestamp: string }
  | { type: 'conversation.updated'; conversationId: string; timestamp: string }
