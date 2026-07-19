# TODO

What remains to take the implemented MVP (see [README status](README.md#status))
to the product described in [ARCHITECTURE.md](ARCHITECTURE.md). Roughly in
priority order.

## 1. Authentication — WorkOS AuthKit

Implemented. `identityFromRequest` in
[src/middleware/auth.ts](src/middleware/auth.ts) verifies bearer
credentials as WorkOS AuthKit access tokens (JWTs checked against WorkOS's
JWKS); everything downstream consumes `Identity { userId, email }`
unchanged. The browser flow lives in [src/routes/auth.ts](src/routes/auth.ts):
protected pages redirect to `/auth/login` on the trusted apex, the AuthKit
callback mints a one-time code for the destination page host, and
`/auth/session` on that host redeems it into a host-only HTTP-only cookie
backed by D1. The `users` table (migration 0002) caches the WorkOS-user →
verified-email mapping. `AUTH_MODE=dev-stub` keeps the old dev bearer stub
for tests/local dev.

- [x] API credentials (WorkOS access tokens verified via JWKS; no parallel
      token system — clients obtain/refresh tokens through WorkOS)
- [x] Browser login flow (AuthKit redirect on the apex origin)
- [x] Page-host sessions (one-time code handoff, host-only cookie, D1-backed)
- [x] User records (`users` table, refreshed at login / first API sight)
- [x] Users are created manually in WorkOS — no signup route.

Remaining WorkOS environment configuration (manual, in the WorkOS
dashboard for each environment):

- [ ] Register the redirect URI: `http://pages.localhost:8787/auth/callback`
      (local dev) and `https://pages.postpage.ai/auth/callback` (production).
- [ ] Create users (invite-only; no signup route).
- [ ] Production secrets: `wrangler secret put WORKOS_API_KEY`,
      `WORKOS_CLIENT_ID`, and `AUTH_SECRET` (any long random string; signs
      the OAuth `state`). Do **not** set `AUTH_MODE` in production.
- [ ] Consider raising the AuthKit access-token lifetime for API/CLI
      ergonomics until the CLI's refresh handling lands.

## 2. CLI

Implemented in [cli/](cli/) as an npm-packaged `postpage` bin (a pnpm
workspace package; zero runtime dependencies, Node ≥ 20, built with tsc).
See [cli/README.md](cli/README.md).

- [x] `postpage publish [file]` / `update <uuid> [file]` — file arg or piped
      stdin; both provided is an error; neither (and no pipe) prints usage.
- [x] `postpage pull <uuid> --output <file>` (stdout without `--output`)
- [x] `postpage list [--collection owned|shared_with_me|all]` with cursor
      handling (`--cursor`, `--limit`, and `--all` to auto-paginate).
- [x] `postpage sharing <uuid> private|public|specific_users --email …`
- [x] `postpage delete <uuid>` (TTY confirmation; `--force` for scripts)
- [x] `--json` output on all commands for agent/script use.
- [x] `postpage login` / `logout` — OAuth 2.0 Device Authorization flow via
      WorkOS CLI Auth (client id via `--client-id` /
      `POSTPAGE_WORKOS_CLIENT_ID` until a production id is baked in), plus
      `login --token` for the dev stub; credentials in
      `~/.config/postpage/credentials.json` (0600), access tokens refreshed
      automatically.
- [x] Packaging decision: npm package `postpage` (single bin, no runtime
      deps); revisit a single-binary build only if install friction shows up.

Remaining CLI follow-ups:

- [ ] Verify the device flow against the real WorkOS staging environment
      (CLI Auth may need enabling per environment in the WorkOS dashboard).
- [ ] Bake the production WorkOS client id into the CLI at release.
- [ ] Publish the package to npm.

## 3. Deployment

- [ ] Create real D1 database + R2 bucket; replace the placeholder
      `database_id` in [wrangler.jsonc](wrangler.jsonc).
- [ ] DNS + wildcard TLS for `*.pages.postpage.ai` (Cloudflare for SaaS /
      custom hostnames or a wildcard route), apex `pages.postpage.ai`, and an
      API hostname; confirm the `postpage.ai` domain assumption.
- [ ] Worker routes for all three host roles (API / apex resolver / page
      hosts) hitting the single Worker's host-based dispatch.
- [ ] Apply migrations to the production D1 (`wrangler d1 migrations apply`).
- [ ] Verify the hosted-page CSP across supported browsers (architecture
      flags this explicitly).
- [ ] CI: run `pnpm test` + `pnpm typecheck` on PRs; deploy on main.

## 4. Hardening & operations (deferred in MVP)

- [ ] **Background deletion**: R2 purge currently runs inline in the DELETE
      request; move to a queue/scheduled cleanup so large pages can't slow or
      fail the request, and orphaned objects (crash between D1 batch and R2
      purge) get swept.
- [ ] **Rate limits & quotas** for the invite-only release.
- [ ] **Logging, metrics, alerts**, and audit retention.
- [ ] **`shared_with_me` query scaling**: currently a table scan with a
      per-row EXISTS (fine at invite-only scale); drive it from
      `page_permissions` by email or add a covering index when it matters.
- [ ] Consider `waitUntil` for the edge-cache write in
      [src/lib/serving.ts](src/lib/serving.ts) so cache population never
      delays a response.

## Explicit non-goals (unchanged from the architecture)

Dashboard, injected scripts, public signup, search/discovery, multi-file
pages, revision browsing/rollback APIs, renaming, custom domains, analytics,
email invitations, MCP server (later, as a thin adapter over the API).
