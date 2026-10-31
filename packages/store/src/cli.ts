import { createMoonskyStore, dropMoonskySchema, migrateMoonskyStore } from './client.js'

const action = process.argv[2]
const databaseUrl = process.env.DATABASE_URL

if (action !== 'up' && action !== 'down') {
  console.error('Usage: moonsky-store <up|down> (requires DATABASE_URL)')
  process.exitCode = 2
} else if (!databaseUrl) {
  console.error('DATABASE_URL is required for MOONSKY storage migrations')
  process.exitCode = 2
} else {
  const store = createMoonskyStore(databaseUrl)
  try {
    if (action === 'up') await migrateMoonskyStore(store)
    else await dropMoonskySchema(store.client)
  } catch {
    console.error(`MOONSKY migration ${action} failed`)
    process.exitCode = 1
  } finally {
    await store.client.end({ timeout: 5 })
  }
}
