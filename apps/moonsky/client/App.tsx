import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Alert } from './components/ui/alert.js'
import { Badge } from './components/ui/badge.js'
import { Button } from './components/ui/button.js'
import { ConfirmDialog } from './components/ui/dialog.js'
import { Input } from './components/ui/input.js'
import { EmptyState, PageHeader, Panel, SplitView, Stat } from './components/layout.js'
import {
  controlChannel,
  fetchChannels,
  fetchConversations,
  fetchDeliveryAttempts,
  fetchMessages,
  login as loginRequest,
  logout as logoutRequest,
  openOperatorSocket,
  type Channel,
  type Conversation,
  type DeliveryAttempt,
  type Message,
  type OperatorInfo,
} from './lib/api.js'

type SocketState = 'connecting' | 'connected' | 'disconnected' | 'error' | 'idle'
type StreamEvent = Record<string, unknown> & { type?: string; channelId?: string; qr?: string; timestamp?: string }
interface Session { token: string; operator: OperatorInfo }

export function App(): ReactNode {
  const [session, setSession] = useState<Session | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [deliveryAttempts, setDeliveryAttempts] = useState<DeliveryAttempt[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [socketState, setSocketState] = useState<SocketState>('idle')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ channel: Channel; action: 'start' | 'logout' } | null>(null)

  const token = session?.token ?? ''
  const isAdmin = session?.operator.role === 'admin'
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId)
  const currentQr = useMemo(() => events.find((event) => event.type === 'channel.qr' && event.channelId && typeof event.qr === 'string'), [events])

  const loadOverview = useCallback(async (sessionToken: string, signal: AbortSignal) => {
    const [channelResponse, conversationResponse] = await Promise.all([
      fetchChannels(sessionToken, signal), fetchConversations(sessionToken, signal),
    ])
    return { channels: channelResponse.data, conversations: conversationResponse.data }
  }, [])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let socket: WebSocket | null = null
    void loadOverview(token, controller.signal).then((overview) => {
      if (controller.signal.aborted) return
      setChannels(overview.channels)
      setConversations(overview.conversations)
      setSelectedId((current) => current || overview.conversations[0]?.id || '')
      setError('')
      if (!isAdmin) { setSocketState('idle'); return }
      socket = openOperatorSocket(token, {
        onState: setSocketState,
        onEvent: (event) => setEvents((existing) => [event as StreamEvent, ...existing].slice(0, 30)),
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'MOONSKY could not be reached.')
    })
    return () => { controller.abort(); socket?.close(); setSocketState('idle') }
  }, [token, isAdmin, loadOverview])

  useEffect(() => {
    if (!token || !selectedId) return
    const controller = new AbortController()
    void Promise.all([
      fetchMessages(selectedId, token, controller.signal),
      fetchDeliveryAttempts(selectedId, token, controller.signal),
    ])
      .then(([messageResponse, attemptResponse]) => {
        setMessages(messageResponse.data)
        setDeliveryAttempts(attemptResponse.data)
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Messages could not be loaded.') })
    return () => controller.abort()
  }, [token, selectedId])

  async function runControl(): Promise<void> {
    if (!pending || !token) return
    const request = pending
    setPending(null)
    setBusy(true)
    setError('')
    const controller = new AbortController()
    try {
      await controlChannel(request.channel.id, request.action, token, controller.signal)
      const overview = await loadOverview(token, controller.signal)
      setChannels(overview.channels)
      setConversations(overview.conversations)
      setSelectedId((current) => current || overview.conversations[0]?.id || '')
      if (request.action === 'logout') setEvents((existing) => existing.filter((event) => !(event.type === 'channel.qr' && event.channelId === request.channel.id)))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Channel action failed.') }
    finally { setBusy(false) }
  }

  async function endSession(): Promise<void> {
    const current = session
    setSession(null)
    setChannels([]); setConversations([]); setMessages([]); setDeliveryAttempts([]); setEvents([]); setSelectedId('')
    if (current) await logoutRequest(current.token, new AbortController().signal).catch(() => undefined)
  }

  if (!session) return <LoginScreen onAuthenticated={setSession} />

  return (
    <div className="moonsky-shell">
      <header className="moonsky-header">
        <PageHeader title="MOONSKY // Operator Inbox" subtitle={`Messages and channels · signed in as ${session.operator.login} (${session.operator.role})`} />
        <div className="moonsky-auth">
          <span className="moonsky-session" aria-live="polite">Session held in memory.</span>
          <Button variant="ghost" onClick={() => void endSession()}>End session</Button>
        </div>
      </header>

      <section className="moonsky-strip" aria-label="Service and channel status">
        <Stat label="WebSocket" value={isAdmin ? socketState : 'read-only'} hint="Authenticated event stream" />
        {channels.length ? channels.map((channel) => <Stat key={channel.id} label={channel.label} value={channel.state} hint={`Channel state · ${channel.id}`} />) : <Stat label="Channels" value={token ? 'loading' : 'not connected'} hint="Actual provider state appears after authentication." />}
      </section>

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <main className="moonsky-main mt-4">
        <SplitView leftRatio="34%" left={
          <Panel title="Inbox" subtitle={`${String(conversations.length)} recent conversations`}>
            {conversations.length === 0 ? <EmptyState title="No conversations" hint="MOONSKY returned no recent conversations." /> : <ul className="moonsky-list" aria-label="Conversations">{conversations.map((conversation) => <li key={conversation.id}><button type="button" className={`moonsky-conversation${selectedId === conversation.id ? ' is-selected' : ''}`} aria-current={selectedId === conversation.id ? 'true' : undefined} onClick={() => setSelectedId(conversation.id)}><span className="moonsky-conversation-title">{conversation.title || conversation.externalId}</span><span className="moonsky-meta">{conversation.status} · {conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString() : 'No message time'}</span></button></li>)}</ul>}
          </Panel>
        } right={
          <div className="moonsky-detail-grid">
            <Panel title={selectedConversation?.title || selectedConversation?.externalId || 'Conversation'} subtitle={selectedConversation ? `Channel account ${selectedConversation.channelAccountId} · ${selectedConversation.status}` : 'Choose a conversation'}>
              {messages.length ? <ol className="moonsky-messages" aria-label="Messages">{messages.map((message) => <li key={message.id} className={`moonsky-message is-${message.direction}`}><div className="moonsky-message-head"><Badge>{message.direction}</Badge><span>{message.status}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><p>{message.body}</p></li>)}</ol> : <EmptyState title={selectedConversation ? 'No messages in this conversation' : 'Inbox detail'} hint="Messages shown here are read from the authenticated MOONSKY API." />}
            </Panel>
            <div className="moonsky-side-stack">
              <Panel title="Channel pairing" subtitle="Pairing data is visible only to this authenticated operator session.">
                {channels.length ? <div className="moonsky-channel-controls">{channels.map((channel) => <div className="moonsky-channel" key={channel.id}><div><strong>{channel.label}</strong><span className="moonsky-meta">State: {channel.state}</span></div><div className="moonsky-actions"><Button variant="ghost" disabled={busy || !isAdmin} onClick={() => setPending({ channel, action: 'start' })}>Start / pair</Button><Button variant="danger" disabled={busy || !isAdmin} onClick={() => setPending({ channel, action: 'logout' })}>Log out</Button></div></div>)}</div> : <EmptyState title="No channel controls" hint="Connect to MOONSKY to inspect registered provider channels." />}
                {!isAdmin ? <p className="moonsky-limitation">Read-only session: channel control requires an administrator.</p> : null}
                {currentQr ? <div className="moonsky-qr" aria-live="polite"><strong>Pairing payload · {String(currentQr.channelId)}</strong><code tabIndex={0}>{String(currentQr.qr)}</code><Button variant="ghost" onClick={() => setEvents((existing) => existing.filter((event) => event !== currentQr))}>Dismiss pairing data</Button></div> : null}
              </Panel>
              <Panel title="Delivery attempts" subtitle="Bounded attempt history from MOONSKY.">
                {deliveryAttempts.length ? <ul className="moonsky-delivery" aria-label="Delivery attempts">{deliveryAttempts.map((attempt) => <li key={attempt.id}><span>Attempt {String(attempt.attemptNumber)} · {new Date(attempt.attemptedAt).toLocaleString()}</span><Badge>{attempt.status}</Badge></li>)}</ul> : <EmptyState title="No delivery attempts" hint="No attempts are recorded for this conversation." />}
              </Panel>
              <Panel title="Recent events" subtitle={`Authenticated WebSocket · ${isAdmin ? socketState : 'read-only'}`}>
                {events.length ? <ul className="moonsky-events" aria-live="polite">{events.slice(0, 8).map((event, index) => <li key={`${String(event.timestamp)}-${String(event.type)}-${String(index)}`}><Badge>{String(event.type || 'event')}</Badge><span>{String(event.channelId || event.conversationId || '')}</span><time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</time></li>)}</ul> : <p className="moonsky-meta">No events received in this session.</p>}
              </Panel>
            </div>
          </div>
        } />
      </main>

      {pending ? <ConfirmDialog open title={`${pending.action === 'logout' ? 'Log out' : 'Start / pair'} ${pending.channel.label}?`} description={pending.action === 'logout' ? 'This changes the provider session and clears any pairing payload from this screen.' : 'This starts the provider and may create a pairing request visible in this authenticated session.'} confirmLabel={pending.action === 'logout' ? 'Log out channel' : 'Start channel'} cancelLabel="Cancel" tone={pending.action === 'logout' ? 'danger' : 'accent'} onConfirm={() => void runControl()} onClose={() => setPending(null)} /> : null}
    </div>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }): ReactNode {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!login.trim() || !password) return
    setBusy(true)
    setError('')
    try {
      const result = await loginRequest(login.trim(), password, new AbortController().signal)
      onAuthenticated({ token: result.token, operator: result.operator })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="moonsky-shell grid place-items-center">
      <form onSubmit={(event) => void submit(event)} className="grid w-full max-w-sm gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold text-zinc-100">MOONSKY</h1>
          <p className="text-xs text-zinc-400">Sign in with a MOONSKY operator account. Sessions are held in memory only.</p>
        </div>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <label className="grid gap-1 text-xs text-zinc-400">
          Login
          <Input autoComplete="username" autoFocus value={login} onChange={(event) => setLogin(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs text-zinc-400">
          Password
          <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !login.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  )
}
