# postpage CLI

First-party command-line interface over the Postpage HTTP API.

```sh
# Publish without logging in at all — the first publish mints a guest
# account (5 pages/day; pages are deleted 1 week after publish) and the
# CLI stores its token so it can keep managing the page
echo '<h1>hi</h1>' | postpage publish

# One-time: log in via the browser (WorkOS device flow) …
postpage login

# … or store a static bearer token (dev stub / CI)
postpage login --token user-1 --api-url http://localhost:8787

# Publish a document
generate-report | postpage publish
postpage publish report.html

# Everything else
postpage update <uuid> report.html
postpage pull <uuid> --output report.html      # stdout without --output
postpage list --collection all --all
postpage sharing <uuid> specific_users --email alex@example.com
postpage delete <uuid> --force
postpage whoami
postpage logout

# Use the API directly with a fresh access token
curl -H "Authorization: Bearer $(postpage token)" https://api.postpage.ai/v1/pages
```

Every command accepts `--json` for machine-readable output and `--api-url`
to target a specific API origin (also `POSTPAGE_API_URL`). A
`POSTPAGE_TOKEN` environment variable overrides stored credentials —
useful for scripts and agents.

## Authentication

`postpage login` runs the OAuth 2.0 Device Authorization flow against
WorkOS CLI Auth: it prints a verification URL and code, waits for browser
approval, and stores the tokens in `~/.config/postpage/credentials.json`
(mode 0600; override the directory with `POSTPAGE_CONFIG_DIR`). Access
tokens are refreshed automatically; when the refresh token expires you are
asked to log in again. The production WorkOS client id is built in;
override it with `--client-id` or `POSTPAGE_WORKOS_CLIENT_ID`.

`postpage publish` needs no authentication at all: with no stored
credentials it publishes anonymously, and the guest bearer token the API
returns (exactly once) is stored as the CLI's credentials so later
`update`/`pull`/`delete` calls work on the page (guests cannot change
sharing; guest pages stay locked to the first browser that opens them).
The token itself is
never printed; `--json` output marks the result with `"guest": true`.
Logging in later replaces the guest credentials — keeping a page past the
anonymous tier means republishing it while signed in.

`postpage token` prints a currently valid access token (refreshing first
when needed) for use outside the CLI, e.g.
`curl -H "Authorization: Bearer $(postpage token)" …`.

## Development

```sh
pnpm build       # tsc -> dist/, bin: dist/main.js
pnpm typecheck
pnpm test        # vitest unit tests
```

No runtime dependencies; requires Node ≥ 20.
