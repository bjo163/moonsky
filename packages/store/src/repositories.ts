import { and, desc, eq, gt, lt } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { MoonskyDatabase } from './client.js'
import {
  channelAccounts,
  conversations,
  deliveryAttempts,
  messages,
  operatorSessions,
  operatorUsers,
} from './schema.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

function pageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`)
  }
  return limit
}

export type ChannelAccount = InferSelectModel<typeof channelAccounts>
export type Conversation = InferSelectModel<typeof conversations>
export type Message = InferSelectModel<typeof messages>
export type DeliveryAttempt = InferSelectModel<typeof deliveryAttempts>

export type NewChannelAccount = Pick<
  InferInsertModel<typeof channelAccounts>,
  'provider' | 'externalAccountId' | 'authRef'
> & Partial<Pick<InferInsertModel<typeof channelAccounts>, 'displayName' | 'status'>>

export type NewConversation = Pick<InferInsertModel<typeof conversations>, 'channelAccountId' | 'externalId'> &
  Partial<Pick<InferInsertModel<typeof conversations>, 'title' | 'status'>>

export type NewMessage = Pick<
  InferInsertModel<typeof messages>,
  'conversationId' | 'direction' | 'body'
> & Partial<Pick<InferInsertModel<typeof messages>, 'externalMessageId' | 'senderId' | 'status'>>

export type NewDeliveryAttempt = Pick<
  InferInsertModel<typeof deliveryAttempts>,
  'messageId' | 'attemptNumber' | 'status'
> & Partial<Pick<InferInsertModel<typeof deliveryAttempts>, 'providerMessageId' | 'errorCode' | 'errorSummary'>>

export async function createChannelAccount(db: MoonskyDatabase, input: NewChannelAccount): Promise<ChannelAccount> {
  const [row] = await db.insert(channelAccounts).values(input).returning()
  if (!row) throw new Error('Failed to create channel account')
  return row
}

export async function findChannelAccount(
  db: MoonskyDatabase,
  provider: string,
  externalAccountId: string,
): Promise<ChannelAccount | null> {
  const [row] = await db.select().from(channelAccounts)
    .where(and(eq(channelAccounts.provider, provider), eq(channelAccounts.externalAccountId, externalAccountId)))
    .limit(1)
  return row ?? null
}

export async function listChannelAccounts(db: MoonskyDatabase): Promise<ChannelAccount[]> {
  return db.select().from(channelAccounts).orderBy(desc(channelAccounts.createdAt), desc(channelAccounts.id)).limit(MAX_PAGE_SIZE)
}

export async function getChannelAccount(db: MoonskyDatabase, id: string): Promise<ChannelAccount | null> {
  const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, id)).limit(1)
  return row ?? null
}

export async function createConversation(db: MoonskyDatabase, input: NewConversation): Promise<Conversation> {
  const [row] = await db.insert(conversations).values(input).returning()
  if (!row) throw new Error('Failed to create conversation')
  return row
}

export async function findConversation(
  db: MoonskyDatabase,
  channelAccountId: string,
  externalId: string,
): Promise<Conversation | null> {
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.channelAccountId, channelAccountId), eq(conversations.externalId, externalId)))
    .limit(1)
  return row ?? null
}

export async function getConversation(db: MoonskyDatabase, id: string): Promise<Conversation | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
  return row ?? null
}

export async function listRecentConversations(db: MoonskyDatabase, limit = DEFAULT_PAGE_SIZE): Promise<Conversation[]> {
  return db.select().from(conversations)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(pageSize(limit))
}

export async function appendMessage(db: MoonskyDatabase, input: NewMessage): Promise<Message> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(messages).values(input).returning()
    if (!row) throw new Error('Failed to append message')
    await tx
      .update(conversations)
      .set({ lastMessageAt: row.createdAt, updatedAt: row.createdAt })
      .where(eq(conversations.id, row.conversationId))
    return row
  })
}

export async function recordDeliveryAttempt(db: MoonskyDatabase, input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
  const [row] = await db.insert(deliveryAttempts).values(input).returning()
  if (!row) throw new Error('Failed to record delivery attempt')
  return row
}

export async function listDeliveryAttempts(
  db: MoonskyDatabase,
  conversationId: string,
  limit = DEFAULT_PAGE_SIZE,
): Promise<Array<Pick<DeliveryAttempt, 'id' | 'messageId' | 'attemptNumber' | 'status' | 'attemptedAt'>>> {
  const rows = await db
    .select({
      id: deliveryAttempts.id,
      messageId: deliveryAttempts.messageId,
      attemptNumber: deliveryAttempts.attemptNumber,
      status: deliveryAttempts.status,
      attemptedAt: deliveryAttempts.attemptedAt,
    })
    .from(deliveryAttempts)
    .innerJoin(messages, eq(deliveryAttempts.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(deliveryAttempts.attemptedAt), desc(deliveryAttempts.id))
    .limit(pageSize(limit))
  return rows
}

export async function listConversations(
  db: MoonskyDatabase,
  channelAccountId: string,
  limit = DEFAULT_PAGE_SIZE,
): Promise<Conversation[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.channelAccountId, channelAccountId))
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(pageSize(limit))
}

export async function listMessages(
  db: MoonskyDatabase,
  conversationId: string,
  limit = DEFAULT_PAGE_SIZE,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(pageSize(limit))
}

export async function getMessage(db: MoonskyDatabase, conversationId: string, messageId: string): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
    .limit(1)
  return row ?? null
}

export type Operator = InferSelectModel<typeof operatorUsers>
export type OperatorSession = InferSelectModel<typeof operatorSessions>
export type OperatorRole = Operator['role']

export async function countOperators(db: MoonskyDatabase): Promise<number> {
  const rows = await db.select({ id: operatorUsers.id }).from(operatorUsers)
  return rows.length
}

export async function createOperator(
  db: MoonskyDatabase,
  input: { login: string; passwordHash: string; role?: OperatorRole },
): Promise<Operator> {
  const [row] = await db
    .insert(operatorUsers)
    .values({ login: input.login, passwordHash: input.passwordHash, role: input.role ?? 'admin' })
    .returning()
  if (!row) throw new Error('operator insert returned no row')
  return row
}

export async function findOperatorByLogin(db: MoonskyDatabase, login: string): Promise<Operator | null> {
  const [row] = await db.select().from(operatorUsers).where(eq(operatorUsers.login, login)).limit(1)
  return row ?? null
}

export async function createOperatorSession(
  db: MoonskyDatabase,
  input: { operatorId: string; tokenHash: string; expiresAt: Date },
): Promise<OperatorSession> {
  const [row] = await db.insert(operatorSessions).values(input).returning()
  if (!row) throw new Error('session insert returned no row')
  return row
}

export async function findOperatorBySessionTokenHash(
  db: MoonskyDatabase,
  tokenHash: string,
  now = new Date(),
): Promise<Operator | null> {
  const [row] = await db
    .select({ operator: operatorUsers })
    .from(operatorSessions)
    .innerJoin(operatorUsers, eq(operatorSessions.operatorId, operatorUsers.id))
    .where(and(
      eq(operatorSessions.tokenHash, tokenHash),
      gt(operatorSessions.expiresAt, now),
      eq(operatorUsers.disabled, false),
    ))
    .limit(1)
  return row?.operator ?? null
}

export async function deleteOperatorSession(db: MoonskyDatabase, tokenHash: string): Promise<void> {
  await db.delete(operatorSessions).where(eq(operatorSessions.tokenHash, tokenHash))
}

export async function deleteExpiredOperatorSessions(db: MoonskyDatabase, now = new Date()): Promise<void> {
  await db.delete(operatorSessions).where(lt(operatorSessions.expiresAt, now))
}
