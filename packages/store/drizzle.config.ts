import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  schemaFilter: ['moonsky'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://moonsky:moonsky@localhost:5433/moonsky',
  },
})
