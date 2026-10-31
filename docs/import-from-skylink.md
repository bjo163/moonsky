# Importing SKYLINK data

MOONSKY reuses the SKYLINK messaging tables (the "D18" boundary in the source
repository) inside a new PostgreSQL schema named `moonsky`. Channel accounts,
conversations, messages and delivery attempts keep their column names and
constraints, so a copy of the SKYLINK tables can be moved without a data
transformation step.

The identity tables are new: SKYLINK relied on ARSY for sessions, while MOONSKY
owns `moonsky.operator_users` and `moonsky.operator_sessions`. Operators do not
need to be imported; the first administrator is created at boot.

## Copying the D18 tables

Run against the source database (schema `skylink`) and the target database
(schema `moonsky`). The example assumes both are reachable from the same psql
session through `dblink` or that the data is exported and imported in order.

```sql
-- 1. Create the target schema and apply migrations first.
--    DATABASE_URL=... pnpm db:migrate

-- 2. Export in dependency order from the source database.
\copy (SELECT * FROM skylink.channel_accounts) TO 'channel_accounts.csv' CSV HEADER
\copy (SELECT * FROM skylink.conversations) TO 'conversations.csv' CSV HEADER
\copy (SELECT * FROM skylink.messages) TO 'messages.csv' CSV HEADER
\copy (SELECT * FROM skylink.delivery_attempts) TO 'delivery_attempts.csv' CSV HEADER

-- 3. Import into the target database.
\copy moonsky.channel_accounts FROM 'channel_accounts.csv' CSV HEADER
\copy moonsky.conversations FROM 'conversations.csv' CSV HEADER
\copy moonsky.messages FROM 'messages.csv' CSV HEADER
\copy moonsky.delivery_attempts FROM 'delivery_attempts.csv' CSV HEADER
```

Import in the order shown so foreign keys resolve. Keep the original UUIDs; they
are preserved by `\copy`.

## What is intentionally not imported

- ARSY sessions and users. MOONSKY issues its own sessions.
- WhatsApp session directories. The WhatsApp adapter is present in the workspace
  but is not wired by the default service entry point; pairing would have to be
  performed again if it is enabled.
- Provider secrets. Bot tokens and webhook secrets are read from environment
  variables, never from D18 rows.

## After import

Start the service with `DATABASE_URL` pointing at the target database. The boot
routine applies migrations, removes expired sessions and creates the bootstrap
administrator only when the operator table is empty.
