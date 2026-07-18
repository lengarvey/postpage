import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { HOSTNAME_PATTERN } from "../lib/names";
import {
  canView,
  getSharedEmails,
  isValidUuid,
  type PageRow,
} from "../lib/pages";
import { getRevisionHtml, pageSecurityHeaders } from "../lib/serving";
import { identityFromBearer } from "../middleware/auth";

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
    // DEV AUTH STUB — the real flow redirects through WorkOS AuthKit and
    // establishes a host-only session cookie for this exact page hostname
    // (see ARCHITECTURE.md "Page-host sessions"). Until then, page visitors
    // authenticate with the same dev bearer tokens the API accepts.
    const identity = identityFromBearer(c.req.header("Authorization"));
    if (identity === null) {
      // Placeholder for the WorkOS login redirect + page-host session.
      return c.text("Authentication required", 401);
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
  return c.redirect(
    `https://${page.hostname}.${c.env.PAGES_DOMAIN}/s/${page.uuid}`,
    302,
  );
}

/** Trusted apex origin (`PAGES_DOMAIN`): only the resolver lives here. */
export const resolverApp = new Hono<{ Bindings: Env }>();
resolverApp.get("/r/:uuid", resolveRedirect);
resolverApp.notFound((c) => c.text("Not found", 404));
