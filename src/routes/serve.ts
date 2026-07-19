import { Hono } from "hono";
import type { Env } from "../env";
import {
  canView,
  canonicalPageUrl,
  getSharedEmails,
  isValidUuid,
  type PageRow,
} from "../lib/pages";
import { getRevisionHtml, pageSecurityHeaders } from "../lib/serving";
import { identityFromRequest } from "../middleware/auth";
import { authCallback, authLogin, identityFromSession, loginUrl } from "./auth";

/**
 * Serving origin (`PAGES_DOMAIN`): only exact `/{uuid}` paths serve content;
 * the reserved `/auth/*` login routes coexist here, and every other path is a
 * 404. Responses are plain text/HTML for browsers, not problem+json.
 *
 * Uploaded HTML from every page shares this origin: isolation rests on the
 * hosted-page CSP plus the API living on a different origin (ARCHITECTURE.md
 * "Page isolation").
 */
export const serveApp = new Hono<{ Bindings: Env }>();

serveApp.get("/auth/login", authLogin);
serveApp.get("/auth/callback", authCallback);

serveApp.get("/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isValidUuid(uuid)) return c.notFound();

  const page = await c.env.DB.prepare("SELECT * FROM pages WHERE uuid = ?")
    .bind(uuid.toLowerCase())
    .first<PageRow>();
  if (page === null) return c.notFound();

  if (page.sharing_mode !== "public") {
    // API clients authenticate with the same bearer credential as the API;
    // browsers use the host-only session cookie established by /auth/callback.
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
      return c.redirect(loginUrl(c.env, canonicalPageUrl(c.env, page.uuid)), 302);
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
