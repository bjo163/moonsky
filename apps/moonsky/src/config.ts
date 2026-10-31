import { z } from 'zod'

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3005),
  DATABASE_URL: z.string().trim().default(''),
  MOONSKY_SERVICE_KEY: z.string().max(256).default(''),
  MOONSKY_TELEGRAM_BOT_TOKEN: z.string().default(''),
  MOONSKY_TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  MOONSKY_BOOTSTRAP_LOGIN: z.string().trim().min(1).max(64).default('admin'),
  MOONSKY_BOOTSTRAP_PASSWORD: z.string().max(256).default(''),
})

export interface MoonskyConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  databaseUrl: string
  serviceKey: string
  telegramBotToken: string
  telegramWebhookSecret: string
  bootstrapLogin: string
  bootstrapPassword: string
}

export function parseConfig(
  environment: Record<string, string | undefined>,
  args: readonly string[] = [],
): MoonskyConfig {
  let requestedPort: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--port') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Invalid command line configuration: --port requires an integer from 1 to 65535.')
      }
      if (requestedPort !== undefined) {
        throw new Error('Invalid command line configuration: --port may be provided only once.')
      }
      requestedPort = value
      index += 1
    } else if (argument?.startsWith('--port=')) {
      if (requestedPort !== undefined) {
        throw new Error('Invalid command line configuration: --port may be provided only once.')
      }
      requestedPort = argument.slice('--port='.length)
    }
  }

  const parsed = ConfigSchema.safeParse({
    NODE_ENV: environment.NODE_ENV,
    HOST: environment.HOST,
    PORT: requestedPort ?? environment.PORT,
    DATABASE_URL: environment.DATABASE_URL,
    MOONSKY_SERVICE_KEY: environment.MOONSKY_SERVICE_KEY,
    MOONSKY_TELEGRAM_BOT_TOKEN: environment.MOONSKY_TELEGRAM_BOT_TOKEN,
    MOONSKY_TELEGRAM_WEBHOOK_SECRET: environment.MOONSKY_TELEGRAM_WEBHOOK_SECRET,
    MOONSKY_BOOTSTRAP_LOGIN: environment.MOONSKY_BOOTSTRAP_LOGIN,
    MOONSKY_BOOTSTRAP_PASSWORD: environment.MOONSKY_BOOTSTRAP_PASSWORD,
  })
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid MOONSKY configuration: ${details}`)
  }

  if (parsed.data.MOONSKY_SERVICE_KEY.length > 0 && parsed.data.MOONSKY_SERVICE_KEY.length < 32) {
    throw new Error('Invalid MOONSKY configuration: MOONSKY_SERVICE_KEY must be at least 32 characters when configured.')
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.DATABASE_URL) {
    throw new Error('Invalid MOONSKY production configuration: DATABASE_URL is required.')
  }
  if (Boolean(parsed.data.MOONSKY_TELEGRAM_BOT_TOKEN) !== Boolean(parsed.data.MOONSKY_TELEGRAM_WEBHOOK_SECRET)) {
    throw new Error('Invalid MOONSKY configuration: Telegram bot token and webhook secret must be configured together.')
  }
  if (parsed.data.MOONSKY_TELEGRAM_WEBHOOK_SECRET.length > 0 && parsed.data.MOONSKY_TELEGRAM_WEBHOOK_SECRET.length < 32) {
    throw new Error('Invalid MOONSKY configuration: Telegram webhook secret must be at least 32 characters.')
  }
  if (parsed.data.MOONSKY_BOOTSTRAP_PASSWORD.length > 0 && parsed.data.MOONSKY_BOOTSTRAP_PASSWORD.length < 12) {
    throw new Error('Invalid MOONSKY configuration: MOONSKY_BOOTSTRAP_PASSWORD must be at least 12 characters.')
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    serviceKey: parsed.data.MOONSKY_SERVICE_KEY,
    telegramBotToken: parsed.data.MOONSKY_TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: parsed.data.MOONSKY_TELEGRAM_WEBHOOK_SECRET,
    bootstrapLogin: parsed.data.MOONSKY_BOOTSTRAP_LOGIN,
    bootstrapPassword: parsed.data.MOONSKY_BOOTSTRAP_PASSWORD,
  }
}

export function loadConfig(): MoonskyConfig {
  return parseConfig(process.env, process.argv.slice(2))
}
