import { Hono } from "hono";
import type { Env } from "../env";
import { HOSTNAME_PATTERN } from "../lib/names";
import {
  canView,
  getSharedEmails,
  isValidUuid,
  r2Key,
  type PageRow,
} from "../lib/pages";
import { getRevisionHtml, pageSecurityHeaders } from "../lib/serving";
import type { Identity } from "../middleware/auth";

/**
 * Hosted-page origin: `{friendly-hostname}.{PAGES_DOMAIN}`. Only the exact
 * `/s/{uuid}` path serves content; every other path is a 404. Responses are
 * plain text/HTML for browsers, not problem+json.
 */
export const serveApp = new Hono<{ Bindings: Env }>();

function notFound(c: { text: (t: string, s: 404) => Response }): Response {
  return c.text("Not found", 404);
}

/**
 * DEV AUTH STUB — the real flow redirects through WorkOS AuthKit and
 * establishes a host-only session cookie for this exact page hostname (see
 * ARCHITECTURE.md "Page-host sessions"). Until then, page visitors can
 * authenticate with the same dev bearer tokens the API accepts.
 */
function identityFromRequest(header: string | undefined): Identity | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) return null;
  return {
    userId: token,
    email: token.includes("@") ? token.toLowerCase() : null,
  };
}

serveApp.get("/s/:uuid", async (c) => {
  const host = new URL(c.req.url).hostname;
  const suffix = `.${c.env.PAGES_DOMAIN}`;
  if (!host.endsWith(suffix)) return notFound(c);
  const friendly = host.slice(0, -suffix.length);
  if (!HOSTNAME_PATTERN.test(friendly)) return notFound(c);

  const requestedUuid = c.req.param("uuid");
  if (!isValidUuid(requestedUuid)) return notFound(c);

  const page = await c.env.DB.prepare(
    "SELECT * FROM pages WHERE hostname = ?",
  )
    .bind(friendly)
    .first<PageRow>();
  // The uuid in the path must belong to this exact hostname.
  if (page === null || page.uuid !== requestedUuid.toLowerCase()) {
    return notFound(c);
  }

  if (page.sharing_mode !== "public") {
    const identity = identityFromRequest(c.req.header("Authorization"));
    if (identity === null) {
      // Placeholder for the WorkOS login redirect + page-host session.
      return c.text("Authentication required", 401);
    }
    const sharedEmails = await getSharedEmails(c.env.DB, page.uuid);
    if (!canView(page, sharedEmails, identity)) {
      return c.text("Access denied", 403);
    }
  }

  if (page.current_revision === null) return notFound(c);
  const html = await getRevisionHtml(
    c.env.PAGES_BUCKET,
    page.uuid,
    page.current_revision,
    r2Key(page.uuid, page.current_revision),
  );
  if (html === null) return notFound(c);

  return c.body(html, 200, pageSecurityHeaders(page.sharing_mode));
});

serveApp.all("*", (c) => notFound(c));

/**
 * Trusted apex origin (`PAGES_DOMAIN`): only the redirect resolver lives
 * here. It must never proxy or render uploaded HTML; it only issues a
 * temporary redirect to the canonical URL read from the page record.
 */
export const resolverApp = new Hono<{ Bindings: Env }>();

resolverApp.get("/r/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isValidUuid(uuid)) return c.text("Not found", 404);
  const page = await c.env.DB.prepare(
    "SELECT uuid, hostname FROM pages WHERE uuid = ?",
  )
    .bind(uuid.toLowerCase())
    .first<{ uuid: string; hostname: string }>();
  if (page === null) return c.text("Not found", 404);
  return c.redirect(
    `https://${page.hostname}.${c.env.PAGES_DOMAIN}/s/${page.uuid}`,
    302,
  );
});

resolverApp.all("*", (c) => c.text("Not found", 404));
