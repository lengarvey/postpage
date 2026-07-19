---
name: postpage
description: Publish HTML to the web with the postpage CLI. Use when asked to publish, share, host, or "put on the web" an HTML page, report, dashboard, or artifact; to update, list, fetch, or delete a published page; to change a page's sharing (make it public/private/share with specific people); or whenever Postpage / postpage.ai is mentioned.
---

# Publishing pages with the postpage CLI

Postpage (postpage.ai) publishes a **single self-contained HTML document** as an
isolated static page with a stable URL. Inline all CSS/JS/SVG and embed images
as data URIs — a strict CSP blocks every external subresource and outbound
request, so separate assets, CDN links, and `fetch` will not work.

## Finding the CLI

Use `postpage` if it is on PATH. Otherwise fall back to the repo build:

```sh
POSTPAGE="$(command -v postpage || echo "node <repo>/cli/dist/main.js")"
```

where `<repo>` is the postpage checkout (build with `pnpm --filter ./cli build`
if `cli/dist/` is missing). Production defaults are baked in — no env vars or
`--api-url` needed.

## Workflow

1. **Check auth**: `postpage whoami`. If it fails, ask the human to run
   `postpage login` themselves — it is a browser device flow you cannot
   complete. (`POSTPAGE_TOKEN` env var also works if the human provides one.)
2. **Publish** from a file or stdin, preferring `--json`:

   ```sh
   postpage publish report.html --json     # or: generate-report | postpage publish --json
   ```

   The JSON includes `uuid`, `url` (`https://pages.postpage.ai/{uuid}`),
   `current_revision`, and `sharing`. Save the `uuid` — you need it for every
   later operation.
3. **Sharing**: pages default to **private** (only the owner can view). To make
   the link work for anyone, or share with specific people:

   ```sh
   postpage sharing <uuid> public
   postpage sharing <uuid> specific_users --email alex@example.com
   postpage sharing <uuid> private
   ```

   Ask before making a page public unless the human already asked for a
   shareable link.
4. **Update, don't re-publish**: to change a page's content, keep the same URL
   by writing a new revision instead of creating a new page:

   ```sh
   postpage update <uuid> report.html --json
   ```
5. **Inspect**: `postpage list --json` (`--collection owned|shared_with_me|all`,
   `--all` to auto-paginate) and `postpage pull <uuid> [--output <file>]` to
   fetch the current HTML.

## Deleting

`postpage delete <uuid> --force` is **immediate and irreversible** — all
revisions are destroyed and the URL is never reused. Only delete when the
human explicitly asks, and confirm the uuid against `postpage list` first.
