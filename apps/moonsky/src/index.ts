import { loadConfig } from './config.js'
import type { MoonskyConfig } from './config.js'
import { createMoonskyServer } from './server.js'
import { countOperators, createChannelAccount, createMoonskyStore, createOperator, deleteExpiredOperatorSessions, findChannelAccount, migrateMoonskyStore } from '@moonsky/store'
import type { MoonskyStore } from '@moonsky/store'
import { TelegramAdapter } from '@moonsky/telegram'
import { createTelegramMoonskyChannel, MoonskyChannelRegistry } from './channels.js'
import { hashPassword } from './session.js'

const DEVELOPMENT_BOOTSTRAP_PASSWORD = 'moonsky-dev-admin-1234'

async function ensureBootstrapOperator(store: MoonskyStore, config: MoonskyConfig): Promise<void> {
  await deleteExpiredOperatorSessions(store.db)
  if (await countOperators(store.db) > 0) return

  const password = config.bootstrapPassword
    || (config.nodeEnv === 'production' ? '' : DEVELOPMENT_BOOTSTRAP_PASSWORD)
  if (!password) {
    throw new Error('No operator exists. Set MOONSKY_BOOTSTRAP_PASSWORD to create the first administrator.')
  }
  if (!config.bootstrapPassword) {
    console.warn(`MOONSKY development bootstrap: created "${config.bootstrapLogin}" with the documented development password. Set MOONSKY_BOOTSTRAP_PASSWORD before any non-local deployment.`)
  }
  await createOperator(store.db, {
    login: config.bootstrapLogin,
    passwordHash: await hashPassword(password),
    role: 'admin',
  })
  console.info(`MOONSKY created bootstrap administrator "${config.bootstrapLogin}".`)
}

async function main(): Promise<void> {
  try {
    const config = loadConfig()
    const hasServiceKey = Boolean(config.serviceKey)
    if (!hasServiceKey) {
      console.warn('MOONSKY starting without MOONSKY_SERVICE_KEY: machine clients cannot authenticate. Operator login still requires the database.')
    }
    let store = null
    if (config.databaseUrl) {
      try {
        store = createMoonskyStore(config.databaseUrl)
        await migrateMoonskyStore(store)
        await ensureBootstrapOperator(store, config)
      } catch (error) {
        console.warn(`MOONSKY database connection failed: ${error instanceof Error ? error.message : String(error)}. Falling back to health-only mode.`)
        store = null
      }
    }
    if (config.telegramBotToken && !store) {
      throw new Error('The MOONSKY store is required when the Telegram provider is configured.')
    }
    const telegram = store && config.telegramBotToken && config.telegramWebhookSecret
      ? new TelegramAdapter({
        botToken: config.telegramBotToken,
        webhookSecret: config.telegramWebhookSecret,
        externalAccountId: 'default',
        authRef: 'secret://environment/MOONSKY_TELEGRAM_BOT_TOKEN',
        store: store.db,
      })
      : undefined
    const channels = new MoonskyChannelRegistry()
    if (store && telegram) {
      const externalAccountId = 'default'
      const account = await findChannelAccount(store.db, 'telegram', externalAccountId)
        ?? await createChannelAccount(store.db, {
          provider: 'telegram',
          externalAccountId,
          authRef: 'secret://environment/MOONSKY_TELEGRAM_BOT_TOKEN',
          status: 'disconnected',
        })
      channels.register(createTelegramMoonskyChannel(telegram, account.id))
    }
    const app = createMoonskyServer(config, { store: store?.db, channels, telegram })
    if (store) app.addHook('onClose', async () => store.client.end({ timeout: 5 }))
    await app.listen({ host: config.host, port: config.port })
    console.info(`MOONSKY service listening on http://${config.host}:${config.port}${store ? '' : ' (health-only mode)'}`)

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        app.close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error(`MOONSKY shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
            process.exit(1)
          },
        )
      })
    }
  } catch (error) {
    console.error(`MOONSKY failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

void main()
