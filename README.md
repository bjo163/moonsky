# MOONSKY

MOONSKY is a standalone operator console for messaging channels. It owns its own
PostgreSQL schema, its own operator identity, and its own deployment. Nothing in
this repository calls another MoonWitness service to sign a person in.

MOONSKY began as the SKYLINK communication surface inside the MoonWitness XV
repository. This repository is the independent extraction: same domain
boundaries, renamed packages, no ARSY dependency and no shared UI package.

## What it does

- Messaging store: channel accounts, conversations, messages and delivery
  attempts, all inside the `moonsky` PostgreSQL schema.
- Telegram transport: webhook ingestion with secret-token verification and
  outbound send through grammY.
- WhatsApp transport: Baileys session pairing driven by the control plane (start
  logs the operator in via QR), inbound traffic persisted into the same store,
  and outbound send. Absent unless `MOONSKY_WHATSAPP_AUTH_DIR` is configured.
- Operator REST API and WebSocket event stream for an inbox UI.
- Local operator identity: scrypt password hashes, SHA-256 session digests,
  12-hour sessions, login throttling, bootstrap administrator.
- shadcn-style operator UI built with Vite, Tailwind CSS v4 and Radix
  primitives. No external component library or private registry is required.

## Boundaries

- MOONSKY is not a Hub and does not own identity for other ecosystems.
- MOONSKY is the only SQL owner of the `moonsky` schema.
- The service credential (`MOONSKY_SERVICE_KEY`) is limited to machine-initiated
  sends and the channel-registration handshake. It cannot read messaging data or
  manage operator sessions.
- Secrets (bot tokens, session tokens, passwords, QR payloads) never enter
  messaging rows or info logs.

## Quick start

### Docker Compose (zero configuration)

```bash
docker compose up --build
```

The console listens on <http://127.0.0.1:3005>. The bundled database is exposed
only on `127.0.0.1:5433`. The first boot creates the `admin` operator; the
default local password is `moonsky-local-admin`. Set
`MOONSKY_BOOTSTRAP_PASSWORD` (12+ characters) before any non-local deployment.

### Local toolchain

Requirements: Node `>=24 <25` and `pnpm@10.33.4`.

```bash
pnpm install
pnpm db:up                 # PostgreSQL on 127.0.0.1:5433
DATABASE_URL=postgresql://moonsky:moonsky@127.0.0.1:5433/moonsky pnpm dev
```

`pnpm dev` builds the library packages, then runs Vite for the UI with a proxy to
the API on port 3005. Without `DATABASE_URL` the service starts in health-only
mode and reports authentication as unavailable.

### Enabling channels

Providers register themselves into the control plane only when configured, and all
of them require `DATABASE_URL` (D18 persistence is mandatory for a real provider).

- **Telegram:** set `MOONSKY_TELEGRAM_BOT_TOKEN` and `MOONSKY_TELEGRAM_WEBHOOK_SECRET`.
- **WhatsApp:** set `MOONSKY_WHATSAPP_AUTH_DIR` to a private session directory
  (for example `whatsapp-session`, which is gitignored). This enables the channel;
  an administrator then pairs it through the control plane (`POST /api/v1/channels/whatsapp/start`),
  and the QR reaches their authenticated WebSocket. The session directory must live on
  a private mount — the zero-config Compose stack intentionally stores no provider
  session in a shared volume.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build libraries, operator UI and service |
| `pnpm typecheck` | Type-check source, tests and client |
| `pnpm test` | Run the full test suite |
| `pnpm lint` | ESLint across the workspace |
| `pnpm dev` | Development UI and API |
| `pnpm db:generate` | Generate a Drizzle migration |
| `pnpm db:migrate` | Apply migrations with `DATABASE_URL` |
| `pnpm db:up` / `pnpm db:down` | Start or stop the local database |

Database-backed tests run only when `DATABASE_URL` points at a local Postgres;
they skip (and say so) otherwise.

## Workspace

| Path | Package | Responsibility |
| --- | --- | --- |
| `apps/moonsky` | `@moonsky/app` | Fastify API, WebSocket events, operator UI |
| `packages/store` | `@moonsky/store` | D18 schema, migrations, repositories, operator sessions |
| `packages/telegram` | `@moonsky/telegram` | Telegram transport adapter |
| `packages/core` | `@moonsky/core` | Shared transport contracts and secret checks |
| `packages/whatsapp` | `@moonsky/whatsapp` | WhatsApp transport adapter (enabled by `MOONSKY_WHATSAPP_AUTH_DIR`) |

## Documentation

- [ADR-0001: standalone MOONSKY identity](docs/decisions/ADR-0001-standalone-identity.md)
- [Importing SKYLINK data](docs/import-from-skylink.md)
