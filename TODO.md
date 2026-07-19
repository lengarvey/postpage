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
- [x] Create users (invite-only; no signup route). Password auth is enabled
      in production; reset links can be minted via the password_reset API.
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
- [ ] **Free-tier quotas and expiry** (mechanics decided 2026-07-19; see
      ARCHITECTURE.md "Plans, quotas, and expiry"):
      - Usage counter table keyed `(owner_id, UTC day)`, incremented with
        page creation; deletes don't refund; exceeded → `429 quota_exceeded`.
      - No update (PUT) limits for now — revision-storage growth is an
        accepted risk to revisit.
      - `plan` column on `users`, default `'free'`.
      - `last_visited_at` (day granularity) on `pages`, initialized to
        creation date, backfilled for existing pages; refreshed by any
        authorized content read when >1 day stale, via `waitUntil`.
      - Daily cron trigger (`triggers.crons` + `scheduled` handler) runs the
        expiry sweep and batched two-phase deletion; absorbs the
        background-deletion item below. No API-call rate limits.
      - Computed `expires_at` in page JSON and `postpage list --json`.
- [ ] **Anonymous publishing** — build together with quotas/expiry (semantics
      decided 2026-07-19; see ARCHITECTURE.md "Anonymous publishing"):
      - Unauthenticated `POST /v1/pages` mints a guest account with a hashed
        bearer token; the guest owns the page and the token authorizes
        update/pull/list/delete.
      - Viewing is link-access locked to the first browser: first view mints
        a host-only viewer cookie and binds the page to it; other browsers
        get a lockout page that upsells signup (the conversion surface).
        No reset — the binding is irrevocable for the page's 1-week life.
        API reads with the guest token bypass the lock. No
        claim-into-account flow yet.
      - 5 pages/day per client IP via the same usage counter table.
      - Fixed 1-week TTL from publish on the same cron sweep; expired guests
        swept with their pages.
- [ ] **CSP test suite**: with a shared serving origin the hosted-page CSP
      is the isolation boundary — pin it with tests (absorbs the old
      "verify CSP across browsers" deployment item).
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
- [ ] CI: run `pnpm test` + `pnpm typecheck` on PRs; deploy on main.
      (Deprioritized 2026-07-19 — not important right now.)

## 5. Hardening & operations (deferred in MVP)

- [ ] **Background deletion**: R2 purge currently runs inline in the DELETE
      request; move it onto the daily cron trigger decided for the expiry
      sweep (section 3) so large pages can't slow or fail the request, and
      orphaned objects (crash between D1 batch and R2 purge) get swept.
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
invitations, MCP server (later, as a thin adapter over the API, paid plan).
