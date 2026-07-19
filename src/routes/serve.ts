import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { HOSTNAME_PATTERN } from "../lib/names";
import {
  canView,
  canonicalPageUrl,
  getSharedEmails,
  isValidUuid,
  type PageRow,
} from "../lib/pages";
import { getRevisionHtml, pageSecurityHeaders } from "../lib/serving";
import { identityFromRequest } from "../middleware/auth";
import {
  authCallback,
  authLogin,
  authSession,
  identityFromSession,
  loginUrl,
} from "./auth";

/**
 * Hosted-page origin: `{friendly-hostname}.{PAGES_DOMAIN}`. Only the exact
 * `/s/{uuid}` path serves content; every other path is a 404. Responses are
 * plain text/HTML for browsers, not problem+json.
 */
export const serveApp = new Hono<{ Bindings: Env }>();

serveApp.get("/s/:uuid", async (c) => {
  const host = new URL(c.req.url).hostname;
  const suffix = `.${c.env.PAGES_DOMAIN}`;
  if (!host.endsWith(suffix)) return c.notFound();
  const friendly = host.slice(0, -suffix.length);
  if (!HOSTNAME_PATTERN.test(friendly)) return c.notFound();

  const requestedUuid = c.req.param("uuid");
  if (!isValidUuid(requestedUuid)) return c.notFound();

  const page = await c.env.DB.prepare(
    "SELECT * FROM pages WHERE hostname = ?",
  )
    .bind(friendly)
    .first<PageRow>();
  // The uuid in the path must belong to this exact hostname.
  if (page === null || page.uuid !== requestedUuid.toLowerCase()) {
    return c.notFound();
  }

  if (page.sharing_mode !== "public") {
    // API clients authenticate with the same bearer credential as the API;
    // browsers use the host-only session cookie established by /auth/session.
    const authHeader = c.req.header("Authorization");
    const identity =
      (await identityFromRequest(c.env, authHeader)) ??
      (await identityFromSession(c));
    if (identity === null) {
      // A presented-but-invalid bearer token is an API request: keep the 401
      // contract. Everything else is a browser: send it through AuthKit.
      if (authHeader !== undefined) {
        return c.text("Authentication required", 401);
      }
      return c.redirect(
        loginUrl(c.env, canonicalPageUrl(c.env, page.hostname, page.uuid)),
        302,
      );
    }
    const sharedEmails =
      page.sharing_mode === "specific_users"
        ? await getSharedEmails(c.env.DB, page.uuid)
        : [];
    if (!canView(page, sharedEmails, identity)) {
      return c.text("Access denied", 403);
    }
  }

  if (page.current_revision === null) return c.notFound();
  const html = await getRevisionHtml(
    c.env.PAGES_BUCKET,
    page.uuid,
    page.current_revision,
  );
  if (html === null) return c.notFound();

  return c.body(html, 200, pageSecurityHeaders(page.sharing_mode));
});

// Page-host sessions: redeems the one-time code minted by the apex callback
// and sets this hostname's session cookie (ARCHITECTURE.md "Page-host
// sessions").
serveApp.get("/auth/session", authSession);

serveApp.notFound((c) => c.text("Not found", 404));

/**
 * Redirect resolver: issues a temporary redirect to the canonical URL read
 * from Postpage's own page record. It must never proxy or render uploaded
 * HTML. Mounted on the trusted apex origin and on the API origin (for local
 * development against localhost).
 */
export async function resolveRedirect(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const uuid = c.req.param("uuid") ?? "";
  if (!isValidUuid(uuid)) return c.text("Not found", 404);
  const page = await c.env.DB.prepare(
    "SELECT uuid, hostname FROM pages WHERE uuid = ?",
  )
    .bind(uuid.toLowerCase())
    .first<{ uuid: string; hostname: string }>();
  if (page === null) return c.text("Not found", 404);
  return c.redirect(canonicalPageUrl(c.env, page.hostname, page.uuid), 302);
}

/**
 * Trusted apex origin (`PAGES_DOMAIN`): the resolver and the AuthKit login
 * endpoints live here. It never serves uploaded HTML.
 */
export const resolverApp = new Hono<{ Bindings: Env }>();
resolverApp.get("/r/:uuid", resolveRedirect);
resolverApp.get("/auth/login", authLogin);
resolverApp.get("/auth/callback", authCallback);
resolverApp.notFound((c) => c.text("Not found", 404));
