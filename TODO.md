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
protected pages redirect to `/auth/login` on the serving origin, and the
AuthKit callback sets a host-only HTTP-only cookie backed by D1 directly
(the one-time-code handoff went away with flat URLs, section 3). The `users`
table (migration 0002) caches the WorkOS-user →
verified-email mapping. `AUTH_MODE=dev-stub` keeps the old dev bearer stub
for tests/local dev.

- [x] API credentials (WorkOS access tokens verified via JWKS; no parallel
      token system — clients obtain/refresh tokens through WorkOS)
- [x] Browser login flow (AuthKit redirect on the apex origin)
- [x] Page-host sessions (host-only cookie, D1-backed; the one-time code
      handoff was removed by flat URLs)
- [x] User records (`users` table, refreshed at login / first API sight)
- [x] Users are created manually in WorkOS — no signup route. (Superseded:
      section 3 makes signup self-serve via AuthKit.)

Remaining WorkOS environment configuration (manual, in the WorkOS
dashboard for each environment):

- [x] Register the redirect URI: `http://pages.localhost:8787/auth/callback`
      (local dev) and `https://pages.postpage.ai/auth/callback` (production).
- [x] Create users (invite-only; no signup route). Password auth is
      currently enabled in production (reset links can be minted via the
      password_reset API); it gets disabled when self-serve signup lands
      (section 3), which is why ARCHITECTURE.md describes it as disabled.
- [x] Production secrets: `wrangler secret put WORKOS_API_KEY`,
      `WORKOS_CLIENT_ID`, and `AUTH_SECRET` (any long random string; signs
      the OAuth `state`). Do **not** set `AUTH_MODE` in production.
- [x] Consider raising the AuthKit access-token lifetime for API/CLI
      ergonomics until the CLI's refresh handling lands. (Moot: the CLI
      refreshes tokens automatically.)

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
      WorkOS CLI Auth (production client id baked in; `--client-id` /
      `POSTPAGE_WORKOS_CLIENT_ID` override), plus `login --token` for the
      dev stub; credentials in `~/.config/postpage/credentials.json` (0600),
      access tokens refreshed automatically. `postpage token` prints a fresh
      access token and `whoami` the signed-in user, so scripts can use
      `Authorization: Bearer $(postpage token)`.
- [x] Packaging decision: npm package `postpage` (single bin, no runtime
      deps); revisit a single-binary build only if install friction shows up.
- [x] Device flow and public-client token refresh verified against the
      production WorkOS environment.

- [x] Agent skill: [skills/postpage/SKILL.md](skills/postpage/SKILL.md) teaches
      Claude Code and similar agents the CLI workflow (install by copying or
      symlinking into `~/.claude/skills/postpage`).

Remaining CLI follow-ups:

- [x] Publish the package to npm (done 2026-07-19).
- [ ] **Guest token revocation**: a guest token is a long-lived static
      bearer with no server-side revoke — `postpage logout` only deletes the
      local file; a leaked token stays valid until the guest account is
      swept. Low stakes (5 pages, 1-week lifetime) but worth a
      revocation endpoint eventually.
- [ ] **Open-sourcing (decided 2026-07-25: whole repo, MIT)** — code and
      npm workflow are ready (LICENSE, license/repository fields,
      trusted-publishing workflow); remaining manual steps:
      - Flip the repository to public on GitHub (history audited
        2026-07-25: no secrets ever committed; `.dev.vars` was always
        gitignored).
      - On npmjs.com, configure the `postpage` package's trusted publisher:
        repo `lengarvey/postpage`, workflow `publish-cli.yml`,
        environment `npm`.
      - Create the `npm` GitHub environment restricted to the `main`
        branch (no required reviewers).

## 3. Self-serve launch (product direction decided 2026-07-19)

Agent-first onboarding: an agent must get from "publish this" to a live page
with the login approval as the only human step. See the revised
[ARCHITECTURE.md](ARCHITECTURE.md) for the target design.

- [x] **Flat URLs** (done 2026-07-19): pages are served at
      `pages.postpage.ai/{uuid}`; per-page hostnames, the `/s/` and `/r/`
      routes, the name generator, and the one-time-code session handoff are
      gone (one host-only cookie on `pages.postpage.ai` covers everything;
      migration 0003). Remaining manual cleanup in the dashboards: delete
      the `*.pages.postpage.ai` ACM certificate and the proxied `*.pages`
      DNS record in Cloudflare, and remove any WorkOS redirect URIs other
      than `https://pages.postpage.ai/auth/callback` (plus the local-dev
      `http://pages.localhost:8787/auth/callback`).
- [ ] **Self-serve signup**: enable AuthKit signup with Magic Auth + GitHub
      OAuth; disable password auth (WorkOS dashboard config, not code).
- [x] **Free-tier quotas and expiry** (done 2026-07-19; see ARCHITECTURE.md
      "Plans, quotas, and expiry"): `usage_counters` keyed (key, UTC day)
      with atomic check-and-increment (30/day free, no refunds on delete,
      `429 quota_exceeded`); no PUT limits; `users.plan` (default `'free'`);
      `pages.last_visited_at` (day granularity, backfilled, refreshed by any
      authorized content read via `waitUntil`); daily cron
      (`triggers.crons` in both wrangler envs + `scheduled` handler) runs
      the expiry sweep (free pages 90 days unvisited, guest pages 1 week
      past publish) and the two-phase deletion (mark in D1 + `r2_purge_queue`,
      purge R2, idempotent) that the DELETE endpoint now also uses; computed
      `expires_at` in page JSON / `postpage list --json`. Migration 0004.
- [x] **Anonymous publishing** (done 2026-07-19, with quotas/expiry):
      unauthenticated `POST /v1/pages` mints a guest account and returns the
      bearer token once (`guest_token`, stored hashed); the token manages
      the guest's pages normally and bypasses the viewer lock; browser
      viewing is link-access locked to the first browser via a host-only
      HTTP-only `pp_viewer` cookie (per-page binding row, irrevocable, no
      claim flow), other browsers get a lockout page that upsells signup;
      5 pages/day per client IP; fixed 1-week TTL on the cron sweep, which
      also sweeps guest accounts whose pages have all expired.
- [x] **CSP test suite**: the hosted-page CSP is pinned by
      [test/serve.test.ts](test/serve.test.ts) ("applies the isolation
      security headers"), which asserts the header string on a real served
      response, including the public/private `frame-ancestors` split.
      Verifying browser *enforcement* of CSP is the browsers' job, not ours
      — the old "verify CSP across browsers" idea is dropped (2026-07-19).
- [ ] **Login quickstart**: `postpage login` success prints the three-line
      publish/share quickstart (the human's onboarding moment; agents get
      theirs from the skill/MCP).
- [ ] Later tier, in ARCHITECTURE.md but not yet scheduled: paid (100/day,
      `specific_users`, MCP access, no expiry).

## 4. Deployment

- [x] Create real D1 database + R2 bucket; replace the placeholder
      `database_id` in [wrangler.jsonc](wrangler.jsonc).
- [x] ~~DNS + wildcard TLS for `*.pages.postpage.ai`~~ (obsolete: flat URLs
      removed the wildcard; the ACM cert and `*.pages` DNS record await
      manual deletion, see section 3).
- [x] Worker routes: custom domains `postpage.ai`, `api.postpage.ai`, and
      `pages.postpage.ai` in [wrangler.jsonc](wrangler.jsonc).
- [x] Apply migrations to the production D1 (`wrangler d1 migrations apply`).
      (Migration 0004 — quotas/guests — still awaits a remote apply + deploy.)
- [x] CI: run `pnpm test` + `pnpm typecheck` on PRs; deploy on main.
      (Done 2026-07-24: [.github/workflows/ci.yml](.github/workflows/ci.yml).)

## 5. MCP server (design in [MCP.md](MCP.md))

Implemented 2026-07-24 in [src/routes/mcp.ts](src/routes/mcp.ts): stateless
Streamable HTTP at `POST /mcp` on the API origin, OAuth protected-resource
metadata pointing at WorkOS AuthKit, and six tools dispatching in-process to
the pages API (tests in [test/mcp.test.ts](test/mcp.test.ts)).

- [x] `/mcp` endpoint, OAuth discovery routes, tools, tests.
- [x] **WorkOS production config** (done 2026-07-25 via the WorkOS API):
      Dynamic Client Registration enabled;
      `https://api.postpage.ai/mcp` registered as the OAuth protected
      resource (`authkit_oauth_resource_01KYC8AJGA74DZX7HNQQ13HHC3`).
- [x] **Config**: `WORKOS_AUTHKIT_DOMAIN` set to
      `https://agile-charm-74.authkit.app` in `env.production.vars` (the
      free WorkOS default domain — a custom `auth.postpage.ai` is a
      US$99/month WorkOS add-on, deferred until the paid tier; switching
      later changes the token issuer and forces connectors to re-auth).
- [ ] **Manual — deploy**, then verify: `npx @modelcontextprotocol/inspector`
      against `https://api.postpage.ai/mcp`, then add the connector in
      Claude (Settings → Connectors) and ChatGPT (Apps & Connectors,
      developer mode).
- [ ] Gate MCP behind the paid plan when it launches (single check at the
      `/mcp` auth step).

## 6. Hardening & operations (deferred in MVP)

- [x] **Background deletion** (done 2026-07-19 with the expiry work): DELETE
      marks in D1 (tombstone + `r2_purge_queue`) and purges R2 via
      `waitUntil`; the daily cron sweeps anything a crash left behind.
- [ ] **Rate limits & quotas** for the invite-only release.
- [ ] **Logging, metrics, alerts**, and audit retention.
- [ ] **`shared_with_me` query scaling**: currently a table scan with a
      per-row EXISTS (fine at invite-only scale); drive it from
      `page_permissions` by email or add a covering index when it matters.
- [ ] Consider `waitUntil` for the edge-cache write in
      [src/lib/serving.ts](src/lib/serving.ts) so cache population never
      delays a response.

## Explicit non-goals (unchanged from the architecture)

Dashboard, injected scripts, search/discovery, multi-file pages, revision
browsing/rollback APIs, renaming, custom domains, analytics, email
invitations.
