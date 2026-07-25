import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { decodeJwt } from "jose";
import type { Env } from "../env";
import { authkitIssuer } from "../lib/workos";
import { bearerToken, identityFromRequest } from "../middleware/auth";
import { pagesApi } from "./pages";

/**
 * Remote MCP server: a stateless Streamable HTTP endpoint at /mcp, secured
 * as an OAuth 2.1 protected resource whose authorization server is WorkOS
 * AuthKit (MCP.md). Tools are a thin adapter that dispatches internal
 * requests to the existing pages API, so quotas, validation, and sharing
 * rules have exactly one implementation.
 *
 * Stateless means: no Mcp-Session-Id, no SSE stream, one JSON response per
 * POST. That is a valid Streamable HTTP server shape and all a tools-only
 * server needs.
 */

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const SERVER_INFO = {
  name: "postpage",
  title: "Postpage",
  version: "0.1.0",
};

const INSTRUCTIONS = `Postpage publishes a self-contained HTML document as an isolated static web page and returns a stable URL.

Use publish_page with a complete HTML document (all CSS/JS/images inline; pages cannot load external resources or make network requests). Pages default to private (only the signed-in owner can view them in a browser); pass sharing_mode "public" when the user wants a link anyone can open. Use update_page to revise a page at the same URL, and set_page_sharing to change who can view it later.`;

/** CORS headers for the MCP endpoint and its discovery metadata. Auth is
 * bearer-token only (never cookies), so a wildcard is safe and keeps
 * browser-based MCP clients working. */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
} as const;

// --- JSON-RPC plumbing -----------------------------------------------------

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// --- Tool definitions --------------------------------------------------------

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const UUID_PROPERTY = {
  type: "string",
  description: "The page's UUID (from publish_page or list_pages).",
} as const;

const TOOLS: ToolDefinition[] = [
  {
    name: "publish_page",
    title: "Publish a page",
    description:
      "Publish a self-contained HTML document as a new Postpage page and " +
      "return its stable URL. The document must inline all CSS, JavaScript, " +
      "and images (data: URIs): hosted pages cannot load external resources " +
      "or make network requests. Pages default to private (viewable in a " +
      "browser only by you, signed in); pass sharing_mode \"public\" for a " +
      "URL anyone can open. Public does not mean listed or indexed.",
    inputSchema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "The complete HTML document to publish (max 10 MiB).",
        },
        sharing_mode: {
          type: "string",
          enum: ["private", "public"],
          description:
            "Initial sharing mode. Defaults to private. Use " +
            "set_page_sharing afterwards for specific_users sharing.",
        },
      },
      required: ["html"],
    },
  },
  {
    name: "update_page",
    title: "Update a page",
    description:
      "Replace a page's HTML with a new revision. The URL and sharing " +
      "settings are unchanged; every update creates a new revision.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: UUID_PROPERTY,
        html: {
          type: "string",
          description: "The complete replacement HTML document (max 10 MiB).",
        },
      },
      required: ["uuid", "html"],
    },
  },
  {
    name: "get_page",
    title: "Get a page",
    description:
      "Fetch a page's metadata (URL, sharing, revision, timestamps, " +
      "expiry). Set include_html to also return the current HTML content.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: UUID_PROPERTY,
        include_html: {
          type: "boolean",
          description: "Include the page's current HTML in the result.",
        },
      },
      required: ["uuid"],
    },
  },
  {
    name: "list_pages",
    title: "List pages",
    description:
      "List your pages, most recently updated first. Collections: owned " +
      "(default), shared_with_me, all. Paginate with the returned " +
      "next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          enum: ["owned", "shared_with_me", "all"],
          description: "Which pages to list. Defaults to owned.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Pages per response (default 50, max 100).",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from a previous response's next_cursor.",
        },
      },
    },
  },
  {
    name: "set_page_sharing",
    title: "Set page sharing",
    description:
      "Replace a page's sharing configuration. private: only you. public: " +
      "anyone with the URL. specific_users: you plus the listed verified " +
      "email addresses (emails is required and must be non-empty). The " +
      "page URL never changes.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: UUID_PROPERTY,
        sharing_mode: {
          type: "string",
          enum: ["private", "public", "specific_users"],
          description: "The new sharing mode.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          description:
            "Email addresses allowed to view the page. Required with " +
            "specific_users, not allowed otherwise.",
        },
      },
      required: ["uuid", "sharing_mode"],
    },
  },
  {
    name: "delete_page",
    title: "Delete a page",
    description:
      "Permanently delete a page. Irreversible: the page becomes " +
      "inaccessible immediately and all revisions are removed.",
    inputSchema: {
      type: "object",
      properties: { uuid: UUID_PROPERTY },
      required: ["uuid"],
    },
  },
];

// --- Tool execution ----------------------------------------------------------

type McpContext = Context<{ Bindings: Env }>;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toolResult(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Dispatch an internal request to the pages API router, forwarding the
 * caller's bearer credential. The router re-verifies it (the JWKS is
 * cached), so tool calls carry exactly the API's authorization semantics.
 */
async function callPagesApi(
  c: McpContext,
  method: string,
  path: string,
  init: { contentType?: string; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: c.req.header("Authorization") ?? "",
  };
  if (init.contentType !== undefined) {
    headers["Content-Type"] = init.contentType;
  }
  return pagesApi.request(
    path,
    { method, headers, body: init.body },
    c.env,
    c.executionCtx,
  );
}

/** Turn a non-2xx API response (problem+json) into a tool error result. */
async function problemToToolError(res: Response): Promise<ToolResult> {
  let message = `Request failed with status ${res.status}.`;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.title === "string") {
      message = body.title;
      if (typeof body.detail === "string") message += ` ${body.detail}`;
      if (typeof body.code === "string") message += ` (code: ${body.code})`;
    }
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  return toolError(message);
}

function argString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

class InvalidToolArguments extends Error {}

function requireArgString(args: Record<string, unknown>, key: string): string {
  const value = argString(args, key);
  if (value === undefined) {
    throw new InvalidToolArguments(`"${key}" is required and must be a string.`);
  }
  return value;
}

async function executeTool(
  c: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "publish_page": {
      const html = requireArgString(args, "html");
      const sharingMode = argString(args, "sharing_mode");
      const created = await callPagesApi(c, "POST", "/", {
        contentType: "text/html; charset=utf-8",
        body: html,
      });
      if (created.status !== 201) return problemToToolError(created);
      const page = (await created.json()) as Record<string, unknown>;
      if (sharingMode !== undefined && sharingMode !== "private") {
        const shared = await callPagesApi(
          c,
          "PUT",
          `/${page.uuid}/sharing`,
          {
            contentType: "application/json",
            body: JSON.stringify({ sharing_mode: sharingMode }),
          },
        );
        if (!shared.ok) {
          // The page exists but sharing did not apply; surface both facts.
          const problem = await problemToToolError(shared);
          return toolError(
            `The page was created as private at ${page.url} (uuid ${page.uuid}), ` +
              `but setting sharing_mode "${sharingMode}" failed: ${problem.content[0]?.text}`,
          );
        }
        return toolResult((await shared.json()) as Record<string, unknown>);
      }
      return toolResult(page);
    }

    case "update_page": {
      const uuid = requireArgString(args, "uuid");
      const html = requireArgString(args, "html");
      const res = await callPagesApi(c, "PUT", `/${uuid}`, {
        contentType: "text/html; charset=utf-8",
        body: html,
      });
      if (!res.ok) return problemToToolError(res);
      return toolResult((await res.json()) as Record<string, unknown>);
    }

    case "get_page": {
      const uuid = requireArgString(args, "uuid");
      const res = await pagesApi.request(
        `/${uuid}`,
        {
          method: "GET",
          headers: {
            Authorization: c.req.header("Authorization") ?? "",
            Accept: "application/json",
          },
        },
        c.env,
        c.executionCtx,
      );
      if (!res.ok) return problemToToolError(res);
      const page = (await res.json()) as Record<string, unknown>;
      if (args.include_html !== true) delete page.html;
      return toolResult(page);
    }

    case "list_pages": {
      const query = new URLSearchParams();
      for (const key of ["collection", "cursor"] as const) {
        const value = argString(args, key);
        if (value !== undefined) query.set(key, value);
      }
      if (typeof args.limit === "number" && Number.isInteger(args.limit)) {
        query.set("limit", String(args.limit));
      }
      const qs = query.size > 0 ? `?${query.toString()}` : "";
      const res = await callPagesApi(c, "GET", `/${qs}`);
      if (!res.ok) return problemToToolError(res);
      return toolResult((await res.json()) as Record<string, unknown>);
    }

    case "set_page_sharing": {
      const uuid = requireArgString(args, "uuid");
      const sharingMode = requireArgString(args, "sharing_mode");
      // Enforce the tool's own schema so client mistakes surface as
      // invalid-params, not downstream API failures.
      if (sharingMode === "specific_users") {
        if (
          !Array.isArray(args.emails) ||
          args.emails.length === 0 ||
          !args.emails.every((e) => typeof e === "string")
        ) {
          throw new InvalidToolArguments(
            '"emails" is required with sharing_mode "specific_users" and ' +
              "must be a non-empty array of strings.",
          );
        }
      } else if (args.emails !== undefined) {
        throw new InvalidToolArguments(
          '"emails" is only allowed with sharing_mode "specific_users".',
        );
      }
      const body: Record<string, unknown> = { sharing_mode: sharingMode };
      if (args.emails !== undefined) body.emails = args.emails;
      const res = await callPagesApi(c, "PUT", `/${uuid}/sharing`, {
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      if (!res.ok) return problemToToolError(res);
      return toolResult((await res.json()) as Record<string, unknown>);
    }

    case "delete_page": {
      const uuid = requireArgString(args, "uuid");
      const res = await callPagesApi(c, "DELETE", `/${uuid}`);
      if (res.status !== 204) return problemToToolError(res);
      return toolResult({ deleted: true, uuid });
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// --- Request handling ----------------------------------------------------------

async function handleRpcMessage(
  c: McpContext,
  message: JsonRpcMessage,
): Promise<Record<string, unknown> | null> {
  // A notification is a request with no id *member* (JSON-RPC 2.0 §4.1);
  // acknowledge it without a body. An explicit `"id": null` is not a
  // notification — answer it with an error rather than silently dropping a
  // message the client may be awaiting.
  if (!("id" in message)) return null;
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return rpcError(
      null,
      RPC_ERRORS.invalidRequest,
      "id must be a string or number.",
    );
  }
  const id = message.id as JsonRpcId;

  if (typeof message.method !== "string") {
    // A client-to-server *response* (id + result/error, no method) is
    // acknowledged and ignored: this server never issues requests.
    if ("result" in message || "error" in message) return null;
    return rpcError(id, RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request.");
  }
  if (message.jsonrpc !== "2.0") {
    return rpcError(id, RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request.");
  }
  const params =
    typeof message.params === "object" && message.params !== null
      ? (message.params as Record<string, unknown>)
      : {};

  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return rpcError(id, RPC_ERRORS.invalidParams, "name must be a string.");
      }
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return rpcResult(id, await executeTool(c, name, args));
      } catch (error) {
        if (error instanceof InvalidToolArguments) {
          return rpcError(id, RPC_ERRORS.invalidParams, error.message);
        }
        throw error;
      }
    }

    default:
      return rpcError(
        id,
        RPC_ERRORS.methodNotFound,
        `Method not found: ${message.method}`,
      );
  }
}

/**
 * Resource metadata (RFC 9728) pointing MCP clients at the AuthKit
 * authorization server. 404 until WORKOS_AUTHKIT_DOMAIN is configured.
 */
function protectedResourceMetadata(c: McpContext): Response {
  // Normalized (trimmed, no trailing slash) so the advertised issuer always
  // matches the one token verification pins in lib/workos.ts.
  const authkitDomain = authkitIssuer(c.env);
  if (authkitDomain === null) {
    return c.json({ error: "OAuth discovery is not configured." }, 404, CORS_HEADERS);
  }
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [authkitDomain],
      bearer_methods_supported: ["header"],
      resource_name: "Postpage",
      resource_documentation: "https://postpage.ai",
    },
    200,
    CORS_HEADERS,
  );
}

/**
 * True unless the bearer token is a JWT that carries an `aud` claim which
 * does not include this MCP server's resource URL. Identity verification
 * (signature, issuer, expiry) has already happened by the time this runs.
 */
function tokenAudienceAllowed(c: McpContext): boolean {
  const token = bearerToken(c.req.header("Authorization"));
  if (token === null) return false;
  let aud: unknown;
  try {
    aud = decodeJwt(token).aud;
  } catch {
    // Not a JWT (dev-stub / guest-format tokens); nothing to check.
    return true;
  }
  if (aud === undefined) return true;
  const resource = `${new URL(c.req.url).origin}/mcp`;
  const audiences = Array.isArray(aud) ? aud : [aud];
  return audiences.includes(resource);
}

function unauthorized(c: McpContext, message: string): Response {
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC_ERRORS.invalidRequest, message },
    },
    401,
    {
      ...CORS_HEADERS,
      "WWW-Authenticate":
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  );
}

export const mcpApp = new Hono<{ Bindings: Env }>();

/**
 * The MCP endpoint has one canonical origin: `api.{apex}` (the AuthKit OAuth
 * resource is registered for that exact URL, and the advertised resource
 * derives from the request origin). The API app also serves the apex, so a
 * connector configured with `https://postpage.ai/mcp` would otherwise fail
 * confusingly mid-OAuth with an unregistered-resource error.
 *
 * The apex `/mcp` endpoint cannot be a redirect: fetch strips Authorization
 * on cross-origin redirects, so authenticated POSTs would land at the
 * canonical host tokenless and every request would 401 — a permanent loop
 * for a connector configured with the apex URL. Instead it fails fast with
 * a 404 whose detail names the canonical URL. The unauthenticated discovery
 * GETs do redirect (308), which plain OAuth tooling follows fine.
 *
 * The apex is derived from PAGES_DOMAIN ("pages.{apex}"), so this also
 * holds in local dev (pages.localhost -> api.localhost) and stays inert if
 * PAGES_DOMAIN ever stops following that shape.
 */
function canonicalMcpUrl(c: Context<{ Bindings: Env }>): string | null {
  const apex = c.env.PAGES_DOMAIN.replace(/^pages\./, "");
  const url = new URL(c.req.url);
  if (apex === c.env.PAGES_DOMAIN || url.hostname !== apex) return null;
  url.hostname = `api.${apex}`;
  return url.toString();
}

mcpApp.use("/mcp", async (c, next) => {
  const canonical = canonicalMcpUrl(c);
  if (canonical !== null) {
    return c.json(
      {
        type: "https://postpage.ai/problems/not-found",
        title: "The MCP server is not served on this host",
        status: 404,
        code: "not_found",
        detail: `Use the canonical MCP URL: ${canonical}`,
      },
      404,
      { ...CORS_HEADERS, "Content-Type": "application/problem+json" },
    );
  }
  await next();
});
const redirectToCanonical = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const canonical = canonicalMcpUrl(c);
    if (canonical !== null) return c.redirect(canonical, 308);
    await next();
  },
);
mcpApp.use("/.well-known/oauth-protected-resource", redirectToCanonical);
mcpApp.use("/.well-known/oauth-protected-resource/mcp", redirectToCanonical);

mcpApp.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
mcpApp.get(
  "/.well-known/oauth-protected-resource/mcp",
  protectedResourceMetadata,
);

mcpApp.options("/mcp", (c) => c.body(null, 204, CORS_HEADERS));
mcpApp.options("/.well-known/oauth-protected-resource", (c) =>
  c.body(null, 204, CORS_HEADERS),
);
mcpApp.options("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.body(null, 204, CORS_HEADERS),
);

// Stateless server: no SSE stream to GET, no session to DELETE.
mcpApp.get("/mcp", (c) =>
  c.json({ error: "This MCP server does not offer a server-push stream." }, 405, {
    ...CORS_HEADERS,
    Allow: "POST, OPTIONS",
  }),
);
mcpApp.delete("/mcp", (c) =>
  c.json({ error: "This MCP server is stateless; there is no session." }, 405, {
    ...CORS_HEADERS,
    Allow: "POST, OPTIONS",
  }),
);

mcpApp.post("/mcp", async (c) => {
  const identity = await identityFromRequest(
    c.env,
    c.req.header("Authorization"),
  );
  if (identity === null) {
    return unauthorized(c, "A valid bearer token is required.");
  }
  // MCP is for signed-in accounts only. Guest tokens are minted by
  // unauthenticated publishes, so accepting them here would make the MCP
  // server effectively anonymous; the 401 challenge points clients at the
  // AuthKit OAuth flow instead.
  if (identity.guest === true) {
    return unauthorized(
      c,
      "MCP requires a signed-in Postpage account; guest tokens cannot " +
        "use the MCP server. Complete the OAuth flow to sign in.",
    );
  }
  // Audience binding (RFC 8707): AuthKit stamps OAuth-flow tokens with an
  // aud of the resource the client requested — the value our discovery
  // metadata advertises. A token carrying an audience for some other
  // resource must not be replayed here. Tokens without an aud (the CLI's
  // api.workos.com family, dev-stub opaque tokens) already verified above
  // and are full-authority by design, so they pass.
  if (!tokenAudienceAllowed(c)) {
    return unauthorized(
      c,
      "The bearer token's audience does not include this MCP server.",
    );
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json(
      rpcError(null, RPC_ERRORS.parse, "Request body is not valid JSON."),
      400,
      CORS_HEADERS,
    );
  }
  // JSON-RPC batching was removed in protocol 2025-06-18; keep the server
  // simple and require one message per POST.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json(
      rpcError(
        null,
        RPC_ERRORS.invalidRequest,
        "Request body must be a single JSON-RPC message.",
      ),
      400,
      CORS_HEADERS,
    );
  }

  // Tool handlers can throw on infrastructure failures (D1/R2); surface
  // those as a JSON-RPC internal error rather than Hono's default text 500,
  // which MCP clients cannot parse.
  let response: Record<string, unknown> | null;
  try {
    response = await handleRpcMessage(c, parsed as JsonRpcMessage);
  } catch {
    const message = parsed as JsonRpcMessage;
    const id =
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : null;
    return c.json(
      rpcError(id, RPC_ERRORS.internal, "Internal server error."),
      500,
      CORS_HEADERS,
    );
  }
  if (response === null) return c.body(null, 202, CORS_HEADERS);
  return c.json(response, 200, CORS_HEADERS);
});
