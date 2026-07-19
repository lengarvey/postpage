# TODO

What remains to take the implemented MVP (see [README status](README.md#status))
to the product described in [ARCHITECTURE.md](ARCHITECTURE.md). Roughly in
priority order.

## 1. Authentication — WorkOS AuthKit

The whole dev stub lives behind one seam: `identityFromBearer` in
[src/middleware/auth.ts](src/middleware/auth.ts). Everything downstream only
consumes `Identity { userId, email }`.

- [ ] **API credentials**: validate bearer credentials against WorkOS and
      derive `userId` + verified `email` from the WorkOS user. Pick the
      credential form/lifecycle WorkOS supports rather than building a
      parallel token system (see architecture "Authentication").
- [ ] **Browser login flow**: replace the `401 Authentication required`
      placeholder in [src/routes/serve.ts](src/routes/serve.ts) with a
      redirect through AuthKit and back to the page.
- [ ] **Page-host sessions**: after login, hand the destination page host a
      short-lived assertion/one-time code and set a secure, HTTP-only,
      host-only session cookie for that exact hostname. Cookies must never be
      shared across page subdomains (architecture "Page-host sessions").
- [ ] **User records**: persist the user-to-WorkOS mapping in D1 where
      needed (schema has no users table yet; add via migration if required).
- [ ] Users are created manually in WorkOS — no signup route.

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
- [ ] `postpage login` / `logout` — OAuth 2.0 Device Authorization flow via
      WorkOS CLI Auth; local credential storage (depends on item 1).
- [ ] Packaging decision (npm? single binary?).

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
