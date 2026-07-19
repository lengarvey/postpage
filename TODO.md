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

- [x] Register the redirect URI: `http://pages.localhost:8787/auth/callback`
      (local dev) and `https://pages.postpage.ai/auth/callback` (production).
- [x] Create users (invite-only; no signup route). Password auth is enabled
      in production; reset links can be minted via the password_reset API.
- [x] Production secrets: `wrangler secret put WORKOS_API_KEY`,
      `WORKOS_CLIENT_ID`, and `AUTH_SECRET` (any long random string; signs
      the OAuth `state`). Do **not** set `AUTH_MODE` in production.
- [ ] Consider raising the AuthKit access-token lifetime for API/CLI
      ergonomics until the CLI's refresh handling lands.

## 2. CLI

First-party interface over the HTTP API (architecture "CLI"). Buildable
against the dev auth stub before item 1 lands.

- [ ] `postpage publish [file]` / `update <uuid> [file]` — file arg or piped
      stdin; both provided is an error; neither (and no pipe) prints usage.
- [ ] `postpage pull <uuid> --output <file>`
- [ ] `postpage list [--collection owned|shared_with_me|all]` with cursor
      handling.
- [ ] `postpage sharing <uuid> private|public|specific_users --email …`
- [ ] `postpage delete <uuid>`
- [ ] `--json` output on all commands for agent/script use.
- [x] `postpage login` / `logout` — OAuth 2.0 Device Authorization flow via
      WorkOS CLI Auth; local credential storage. Implemented in
      [cli/postpage.mjs](cli/postpage.mjs) (zero-dep Node script) along with
      `token` (prints a fresh access token, auto-refreshing) and `whoami`;
      scripts use `Authorization: Bearer $(postpage token)`.
- [ ] Packaging decision (npm? single binary?).

## 3. Deployment

- [x] Create real D1 database + R2 bucket; replace the placeholder
      `database_id` in [wrangler.jsonc](wrangler.jsonc).
- [x] DNS + wildcard TLS for `*.pages.postpage.ai`: proxied `*.pages` CNAME
      + zone route, with an Advanced Certificate (ACM) covering
      `*.pages.postpage.ai` since Universal SSL stops one level deep.
- [x] Worker routes for all three host roles: custom domains `postpage.ai`,
      `api.postpage.ai`, `pages.postpage.ai` plus the wildcard zone route,
      all in [wrangler.jsonc](wrangler.jsonc).
- [x] Apply migrations to the production D1 (`wrangler d1 migrations apply`).
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
