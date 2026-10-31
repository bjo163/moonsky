export interface Channel { id: string; label: string; state: string }
export interface Conversation {
  id: string; channelAccountId: string; externalId: string; title: string | null
  status: string; lastMessageAt: string | null; createdAt: string; updatedAt: string
}
export interface Message {
  id: string; conversationId: string; externalMessageId: string | null; direction: string
  senderId: string | null; body: string; status: string; createdAt: string
}
export interface DeliveryAttempt {
  id: string; messageId: string; attemptNumber: number; status: string; attemptedAt: string
}
export interface Envelope<T> { ok: true; data: T; timestamp: string }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError' }
}

async function request<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal,
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    let message = `Request failed (${String(response.status)}).`
    try {
      const body = await response.json() as { error?: { message?: unknown } }
      if (typeof body.error?.message === 'string') message = body.error.message
    } catch { /* keep status fallback */ }
    throw new ApiError(response.status, message)
  }
  return await response.json() as T
}

export const fetchChannels = (token: string, signal: AbortSignal) => request<Envelope<Channel[]>>('/api/v1/channels', token, signal)
export const fetchConversations = (token: string, signal: AbortSignal) => request<Envelope<Conversation[]>>('/api/v1/conversations?limit=100', token, signal)
export const fetchMessages = (id: string, token: string, signal: AbortSignal) => request<Envelope<Message[]>>(`/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=100`, token, signal)
export const fetchDeliveryAttempts = (id: string, token: string, signal: AbortSignal) => request<Envelope<DeliveryAttempt[]>>(`/api/v1/conversations/${encodeURIComponent(id)}/delivery-attempts?limit=100`, token, signal)

export interface OperatorInfo { login: string; role: string }
export interface LoginResult { token: string; expiresAt: string; operator: OperatorInfo }

async function failure(response: Response): Promise<ApiError> {
  let message = `Request failed (${String(response.status)}).`
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') message = body.error.message
  } catch { /* keep status fallback */ }
  return new ApiError(response.status, message)
}

export async function login(loginValue: string, password: string, signal: AbortSignal): Promise<LoginResult> {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginValue, password }),
  })
  if (!response.ok) throw await failure(response)
  return (await response.json() as Envelope<LoginResult>).data
}

export async function logout(token: string, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/v1/auth/logout', {
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })
  if (!response.ok && response.status !== 401) throw await failure(response)
}

export async function controlChannel(id: string, action: 'start' | 'logout', token: string, signal: AbortSignal): Promise<{ id: string; state: string }> {
  const response = await fetch(`/api/v1/channels/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    let message = `Request failed (${String(response.status)}).`
    try {
      const body = await response.json() as { error?: { message?: unknown } }
      if (typeof body.error?.message === 'string') message = body.error.message
    } catch { /* keep status fallback */ }
    throw new ApiError(response.status, message)
  }
  return (await response.json() as Envelope<{ id: string; state: string }>).data
}

export function openOperatorSocket(token: string, handlers: {
  onState: (state: 'connecting' | 'connected' | 'disconnected' | 'error') => void
  onEvent: (event: Record<string, unknown>) => void
}): WebSocket {
  const browser = globalThis as typeof globalThis & { location: { protocol: string; host: string }; WebSocket: typeof WebSocket }
  const socket = new browser.WebSocket(`${browser.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${browser.location.host}/ws`)
  handlers.onState('connecting')
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', authorization: `Bearer ${token}` })), { once: true })
  socket.addEventListener('message', (message) => {
    try {
      const frame = JSON.parse(String(message.data)) as Record<string, unknown>
      if (frame.type === 'auth') {
        if (frame.ok === true) handlers.onState('connected')
        else handlers.onState('error')
      } else handlers.onEvent(frame)
    } catch { handlers.onState('error') }
  })
  socket.addEventListener('close', () => handlers.onState('disconnected'))
  socket.addEventListener('error', () => handlers.onState('error'))
  return socket
}
