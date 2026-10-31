# ADR-0001: MOONSKY is a standalone service with its own operator identity

- Status: Accepted
- Date: 2026-10-31
- Repository: moonsky

## Context

The SKYLINK communication surface was implemented inside the MoonWitness XV
repository. MoonWitness ADR-0006 defined SKYLINK as an ARSY-dependent surface:
ARSY issued the sessions and the SKYLINK process validated them over HTTP, while
the UI consumed the shared `@moonwitness/moonui` package from the monorepo.

The owner decided to move the surface out of MoonWitness XV into an independent
repository named MOONSKY with package scope `@moonsky/*`, and to give it its own
operator identity rather than validating another service's sessions. Publishing
the shared UI package to a private registry was rejected as an unnecessary
dependency; the operator UI now uses local shadcn-style components instead.

"D18" in inherited material refers to the messaging-store boundary. In this
repository it is simply the `moonsky` PostgreSQL schema.

## Decision

1. MOONSKY is a standalone repository and deployment. It does not import code
   from MoonWitness XV and does not call ARSY.
2. MOONSKY owns operator identity. Operators are rows in
   `moonsky.operator_users`; credentials are scrypt hashes; sessions are random
   bearer tokens whose SHA-256 digests live in `moonsky.operator_sessions` with a
   12-hour expiry. There is no cookie session and no upstream session probe.
3. The first administrator is created at boot only when no operator exists, from
   `MOONSKY_BOOTSTRAP_LOGIN` and `MOONSKY_BOOTSTRAP_PASSWORD`. Production refuses
   to create a default password.
4. The shared service credential `MOONSKY_SERVICE_KEY` is scoped to
   machine-initiated sends and the channel-registration handshake. It cannot read
   D18 data, control channels or manage operators.
5. MOONSKY is the only SQL owner of the `moonsky` PostgreSQL schema. It creates
   its own migration ledger inside that schema.
6. The operator UI is built locally with Vite, Tailwind CSS v4, Radix primitives
   and shadcn-style components. No private registry is required.

## Consequences

- MoonWitness ADR-0006's identity dependency no longer describes MOONSKY. That
  remains true for as long as MoonWitness XV keeps its in-repo SKYLINK copy; any
  later removal there is a separate decision in that repository.
- ARSY can still call MOONSKY as a machine client with the service key, but
  MOONSKY no longer needs ARSY to be available in order to serve its operators.
- Removing the upstream session cache removes an entire failure mode and the
  15-second cache ceiling that came with it. Authentication now fails closed when
  the database is unavailable (503 `auth_unavailable`).
- The operator UI no longer receives MoonWitness design-system updates
  automatically. UI consistency with MoonWitness is a product choice, not a
  runtime dependency.
