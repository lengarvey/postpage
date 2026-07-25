# MCP support plan

Goal: a **remote MCP server** so hosted assistants — Claude (claude.ai
connectors) and ChatGPT (connectors / developer mode) — can publish, update,
share, and delete Postpage pages server-side. "Publish this analysis to
Postpage" becomes a single tool call from a chat.

ARCHITECTURE.md already anticipated this: *"an MCP server … planned as a thin
adapter over the HTTP API."* This plan makes that concrete.

## Design decisions

### Transport: Streamable HTTP, stateless, on the API origin

- Endpoint: `POST https://api.postpage.ai/mcp` (also served on the apex,
  like the rest of the API app).
- **Stateless**: every POST is handled independently — no `Mcp-Session-Id`,
  no SSE stream, plain `application/json` responses. This is valid Streamable
  HTTP per the MCP spec, fits Workers (no Durable Objects needed), and is all
  that tools-only servers require. `GET /mcp` returns 405 (no server-push).
- No SDK dependency: the JSON-RPC surface we need (`initialize`, `ping`,
  `tools/list`, `tools/call`, notifications) is small; a hand-rolled handler
  keeps the Worker dependency-free and testable with the existing vitest
  workers pool. Supported protocol versions: `2025-06-18`, `2025-03-26`,
  `2024-11-05`.

### Auth: OAuth 2.1 resource server, WorkOS AuthKit as the authorization server

The MCP authorization spec is exactly the shape WorkOS AuthKit provides
("AuthKit for MCP"): AuthKit is a full OAuth 2.1 authorization server with
authorization-server metadata and Dynamic Client Registration, and the access
tokens it issues are the same JWTs the Postpage API already verifies against
WorkOS's JWKS.

So Postpage is only the **protected resource**:

- Requests without a valid bearer token get `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- `GET /.well-known/oauth-protected-resource` (and the `/mcp` path-suffixed
  form) returns the resource metadata pointing at the AuthKit issuer
  (`WORKOS_AUTHKIT_DOMAIN`, a new env var).
- Claude/ChatGPT discover the metadata, register a client via DCR against
  AuthKit, run the browser consent flow with the user, and then call `/mcp`
  with a normal AuthKit access token.
- Token verification reuses `identityFromRequest` — no parallel auth
  system. WorkOS issues two token families, and verification routes on an
  **issuer allowlist** (never the token's own say-so): `https://api.workos.com`
  tokens (SDK / CLI device flow) verify against
  `api.workos.com/sso/jwks/{clientId}`, and AuthKit-domain tokens (the MCP
  OAuth flow) verify against `{WORKOS_AUTHKIT_DOMAIN}/oauth2/jwks`. Any
  other issuer, or a missing one, is rejected.
- **Audience binding (RFC 8707)**: AuthKit stamps OAuth-flow tokens with an
  `aud` of the requested resource. The `/mcp` gate rejects any token whose
  `aud` doesn't include this server's resource URL, so a token minted for a
  different MCP server can't be replayed here. Tokens without an `aud`
  (CLI/SDK family) pass — they're full-authority by design.

CORS: permissive (`*`) on `/mcp` and the well-known routes. Auth is bearer
tokens, never cookies, so this is safe, and it keeps browser-based MCP
clients (e.g. the MCP inspector) working.

### Tools: a thin adapter that dispatches to the existing HTTP API

Tool handlers build internal `Request`s and dispatch them to the existing
`pagesApi` Hono router in-process (`pagesApi.request(...)`), forwarding the
caller's `Authorization` header. Zero duplicated business logic: quotas,
validation, revisions, sharing rules, and problem+json errors all come from
the one implementation. API errors surface as tool results with
`isError: true` and the problem `title`/`detail`/`code`.

| Tool | Maps to |
|---|---|
| `publish_page(html, sharing_mode?)` | `POST /v1/pages`, then `PUT /v1/pages/{uuid}/sharing` when `sharing_mode: "public"` is requested |
| `update_page(uuid, html)` | `PUT /v1/pages/{uuid}` |
| `get_page(uuid, include_html?)` | `GET /v1/pages/{uuid}` (`Accept: application/json`; `html` stripped unless requested, to keep tool output small) |
| `list_pages(collection?, limit?, cursor?)` | `GET /v1/pages` |
| `set_page_sharing(uuid, sharing_mode, emails?)` | `PUT /v1/pages/{uuid}/sharing` |
| `delete_page(uuid)` | `DELETE /v1/pages/{uuid}` |

Results carry both human-readable `content` text and `structuredContent`
(the API's JSON resource, e.g. `{uuid, url, current_revision, sharing,
created_at, updated_at, expires_at}`), so agents get the page URL reliably.

`publish_page` defaults to `private` (matching the API); `sharing_mode:
"public"` exists because "publish and give me a link I can send around" is
the dominant chat-assistant flow. `specific_users` stays on
`set_page_sharing`, which requires the emails array.

### Plan gating

MCP requires a signed-in account: guest tokens (minted by anonymous
publishing) are rejected at the `/mcp` auth gate with the OAuth challenge,
because accepting them would make the MCP server usable with zero signup.

ARCHITECTURE.md additionally bundles MCP access with the (future) paid plan.
There is no paid plan yet, so the MCP endpoint is open to every signed-in
identity for now. When paid launches, the gate is one more check at the same
`/mcp` auth step (look up `users.plan` for the verified identity) — noted
here so it isn't forgotten.

## What we implement (code, this branch)

- [x] `src/routes/mcp.ts` — well-known resource metadata, the stateless
      Streamable HTTP handler, JSON-RPC plumbing, and the six tools.
- [x] `src/env.ts` + `wrangler.jsonc` + vitest bindings — new
      `WORKOS_AUTHKIT_DOMAIN` var (empty ⇒ OAuth discovery routes 404, `/mcp`
      itself still accepts valid bearer tokens).
- [x] `src/index.ts` — mount the MCP routes on the API app.
- [x] `test/mcp.test.ts` — auth challenge, discovery metadata, initialize /
      tools/list handshake, every tool end-to-end against the real router
      (dev-stub auth), and error mapping.
- [x] Doc updates: ARCHITECTURE.md (MCP section, drop the non-goal),
      TODO.md (new section with the manual checklist), README mention.

## What you (Len) need to do manually

Steps 1–2 were completed 2026-07-25 through the WorkOS API: Dynamic Client
Registration is enabled in the production environment,
`https://api.postpage.ai/mcp` is registered as the OAuth protected resource,
and `WORKOS_AUTHKIT_DOMAIN` is committed as
`https://agile-charm-74.authkit.app` (the free WorkOS default; a custom
`auth.postpage.ai` is a US$99/month add-on, deferred until the paid tier —
switching later changes the token issuer and forces connectors to re-auth).

1. ~~WorkOS dashboard — enable Dynamic Client Registration.~~ Done.
2. ~~Find your AuthKit domain and set `WORKOS_AUTHKIT_DOMAIN`.~~ Done.
3. **Deploy**: `pnpm deploy:prod` (after the usual migrations, though this
   feature needs no new migration).
4. **Smoke-test** with the inspector:
   `npx @modelcontextprotocol/inspector` → Streamable HTTP →
   `https://api.postpage.ai/mcp` → complete the OAuth flow → call
   `publish_page`.
5. **Add the connector in Claude**: claude.ai → Settings → Connectors →
   Add custom connector → URL `https://api.postpage.ai/mcp`. Claude walks
   the OAuth flow; approve it with your Postpage (WorkOS) login.
6. **Add the connector in ChatGPT**: Settings → Apps & Connectors (enable
   Developer mode) → Create → MCP server URL `https://api.postpage.ai/mcp`,
   auth = OAuth. Note ChatGPT's connector availability varies by plan.
7. Optional cleanup later: when the paid plan ships, flip the gating check
   (see "Plan gating") and update AuthKit consent copy if desired.

## Out of scope (for now)

- SSE streaming / server-initiated messages, sessions, resumability — not
  needed for tools-only usage.
- MCP resources/prompts/elicitation — the tools cover the product surface.
- Scoped tokens: AuthKit tokens carry the user's full authority, same as
  the API and CLI today (ARCHITECTURE.md defers fine-grained scopes).
- Publishing the server to MCP registries/directories.
