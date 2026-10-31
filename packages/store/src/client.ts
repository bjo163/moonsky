import { fileURLToPath } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { moonskySchema } from './schema.js'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

export type MoonskyDatabase = PostgresJsDatabase<typeof moonskySchema>

export interface MoonskyStore {
  db: MoonskyDatabase
  client: Sql
}

export function createMoonskyStore(databaseUrl: string): MoonskyStore {
  const client = postgres(databaseUrl, { max: 5 })
  return { db: drizzle(client, { schema: moonskySchema }), client }
}

/** Apply this package's migrations and keep the migration ledger inside its schema. */
export async function migrateMoonskyStore(store: MoonskyStore): Promise<void> {
  await store.client`CREATE SCHEMA IF NOT EXISTS "moonsky"`
  await migrate(store.db, {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsSchema: 'moonsky',
    migrationsTable: '__drizzle_migrations',
  })
}

/** Roll back only the schema owned by this package. */
export async function dropMoonskySchema(client: Sql): Promise<void> {
  await client`DROP SCHEMA IF EXISTS "moonsky" CASCADE`
}
