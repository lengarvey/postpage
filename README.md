# postpage

Publish a self-contained HTML document as an isolated static web page.

- [Architecture](ARCHITECTURE.md)

## Development

A Cloudflare Worker (Hono) backed by D1 (metadata) and R2 (immutable HTML
revisions). Runs entirely locally via wrangler/workerd.

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

# view it as a page visitor (page hosts are simulated with a Host header)
curl -s http://localhost:8787/s/<uuid> -H 'Host: <hostname>.pages.postpage.ai'

# resolver redirect
curl -si http://localhost:8787/r/<uuid> -H 'Host: pages.postpage.ai'
```
