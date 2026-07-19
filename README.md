# Postpage

Publish a self-contained HTML document as an isolated static web page — from
an API call or a pipe.

Postpage is built for coding agents and scripts that generate HTML artifacts
(reports, analyses, documentation, dashboards) and need somewhere to put them.
You `POST` raw HTML and get back a stable URL. No dashboard, no build step, no
asset pipeline: one document, one page, served byte-for-byte unchanged.

```sh
generate-report | curl -s -X POST https://api.postpage.ai/v1/pages \
  -H 'Authorization: Bearer …' -H 'Content-Type: text/html; charset=utf-8' \
  --data-binary @-
```

## What makes it different

- **Every page is its own browser origin.** Each page gets a unique,
  never-reused hostname (`amber-otter-k7.pages.postpage.ai`), so one page's
  JavaScript can never read another page — even when a visitor is authorized
  for both.
- **Pages are hermetic.** A strict Content Security Policy allows fully
  inline HTML/CSS/JS/SVG but blocks all external subresources and outbound
  connections (`fetch`, websockets, beacons, form posts). Uploaded documents
  render; they don't phone home.
- **Sharing is enforced at the edge, on every request.** A page is `private`
  (owner only), `public` (anyone with the URL), or shared with
  `specific_users` by email. Changing the mode takes effect on the next
  request — the URL never changes, and nothing needs a cache purge.
- **Updates are revisions.** Every `PUT` writes a new immutable revision;
  bytes are stored unchanged and old revisions are retained while the page
  exists. Deletion is immediate and irreversible, leaving only a tombstone so
  the hostname is never reassigned.
- **Not discoverable by default.** Pages are unlisted, `noindex`, and served
  with `no-referrer`. Public means "anyone with the complete URL", nothing
  more.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## API at a glance

All endpoints require a bearer token. Errors are RFC 9457
`application/problem+json` with a stable `code`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/pages` | Create a page from a raw HTML body (≤ 10 MiB). Defaults to private. |
| `GET /v1/pages/{uuid}` | Current HTML (`Accept: text/html`, the default) or metadata + HTML (`Accept: application/json`). |
| `PUT /v1/pages/{uuid}` | Replace content — always creates a new revision. |
| `PUT /v1/pages/{uuid}/sharing` | Replace the sharing configuration. |
| `DELETE /v1/pages/{uuid}` | Delete the page and all revisions. Irreversible. |
| `GET /v1/pages?collection=owned\|shared_with_me\|all` | List pages, newest-updated first, cursor-paginated. |
| `GET pages.postpage.ai/r/{uuid}` | Convenience resolver → 302 to the canonical page URL. |

## Stack

A single Cloudflare Worker (Hono) is the only public route to content:
D1 holds page/revision/permission metadata, a private R2 bucket holds the
immutable HTML revisions, and an edge cache keyed by `uuid + revision` serves
bytes without ever caching an authorization decision.

## Development

Runs entirely locally via wrangler/workerd — no Cloudflare account needed.

```sh
pnpm install
pnpm db:migrate:local   # apply D1 migrations to the local database
pnpm dev                # wrangler dev on http://localhost:8787
pnpm test               # vitest with real D1/R2 bindings (workerd)
pnpm typecheck
```

### Layout

```
migrations/        D1 schema migrations
src/index.ts       host-based dispatch: API / apex resolver / page hosts
src/routes/        pages API (/v1/pages...), page serving + resolver
src/lib/           storage, naming, negotiation, cursors, serving headers
src/middleware/    dev auth stub (to be replaced by WorkOS AuthKit)
test/              integration + unit tests
```

### Auth stub

WorkOS AuthKit is not integrated yet. The bearer token itself is the
identity: `Authorization: Bearer user-1` is user `user-1`; an email-shaped
token (`Bearer alex@example.com`) also acts as that verified email so
`specific_users` sharing can be exercised. See `src/middleware/auth.ts`.

### Browsing pages locally

Browsers resolve `*.localhost` to 127.0.0.1, so a `.dev.vars` file (wrangler's
local-only env overrides, gitignored) makes hosted pages directly openable:

```sh
cat > .dev.vars <<'EOF'
PAGES_DOMAIN=pages.localhost
PAGES_URL_BASE=http://pages.localhost:8787
EOF
```

With that, the API stays on `http://localhost:8787`, page URLs returned by the
API look like `http://{hostname}.pages.localhost:8787/s/{uuid}` and open
straight in a browser (make the page public first, since browser login is not
wired up yet), and the resolver lives at `http://pages.localhost:8787/r/{uuid}`.

### Trying it locally

```sh
# create a page (defaults to private)
curl -s -X POST http://localhost:8787/v1/pages \
  -H 'Authorization: Bearer me' -H 'Content-Type: text/html; charset=utf-8' \
  --data-binary @page.html

# make it public
curl -s -X PUT http://localhost:8787/v1/pages/<uuid>/sharing \
  -H 'Authorization: Bearer me' -H 'Content-Type: application/json' \
  -d '{"sharing_mode":"public"}'

# open the returned url in a browser, or view it with curl
curl -s http://<hostname>.pages.localhost:8787/s/<uuid>

# resolver redirect
curl -si http://pages.localhost:8787/r/<uuid>
```

## Installing the agent skill

[skills/postpage/SKILL.md](skills/postpage/SKILL.md) teaches Claude Code (and
similar agents) to publish and manage pages via the CLI. Install it with:

```sh
cp -r skills/postpage ~/.claude/skills/postpage
```

(or symlink it to track the repo: `ln -s "$PWD/skills/postpage" ~/.claude/skills/postpage`).

## Status

The HTTP API, page serving, and WorkOS AuthKit authentication described
above are implemented and tested (79 tests running against real D1/R2
bindings in workerd). API bearer credentials are WorkOS access tokens
verified against WorkOS's JWKS; browsers reach protected pages through an
AuthKit login on the trusted apex followed by a one-time code handoff that
sets a host-only session cookie for that exact page hostname. Local
development can keep using the dev bearer stub via `AUTH_MODE=dev-stub` in
`.dev.vars`. WorkOS setup (dashboard redirect URI + `wrangler secret put`
for `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `AUTH_SECRET`) is described in
[TODO.md](TODO.md).

Not yet built (details in [TODO.md](TODO.md)):

- [ ] **CLI** (`postpage publish/update/pull/list/sharing/delete` + device-flow login)
- [ ] **Deployment** — Cloudflare account wiring, real D1/R2 resources, DNS
      and wildcard TLS for `*.pages.postpage.ai`
- [ ] Background deletion, rate limits, logging/metrics (deferred in the MVP)
