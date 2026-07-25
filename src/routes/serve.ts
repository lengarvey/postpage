import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import { bindViewer, isGuestOwner } from "../lib/guests";
import {
  canView,
  canonicalPageUrl,
  getSharedEmails,
  isValidUuid,
  refreshLastVisited,
  type PageRow,
} from "../lib/pages";
import { getRevisionHtml, pageSecurityHeaders } from "../lib/serving";
import { randomToken } from "../lib/signing";
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

/** Viewer-lock cookie for guest pages: host-only, HTTP-only, one per browser. */
export const VIEWER_COOKIE = "pp_viewer";
const VIEWER_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * Lockout page for guest-owned pages opened in a second browser. Deliberate
 * friction and the anonymous tier's conversion surface (ARCHITECTURE.md
 * "Anonymous publishing").
 */
const LOCKOUT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>This page is locked to another browser</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto 0; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  p { line-height: 1.55; }
  a { color: #0b57d0; }
</style></head>
<body>
<h1>This page is locked to another browser</h1>
<p>This page was published anonymously, so it can only be viewed in the
first browser that opened it &mdash; and that wasn&rsquo;t this one. The lock
cannot be reset, and the page will be deleted a week after it was published.</p>
<p><a href="https://postpage.ai">Sign up for Postpage</a> to publish pages you
can open from any browser, share with specific people, and keep alive as long
as you use them.</p>
</body>
</html>
`;

type Ctx = Context<{ Bindings: Env }>;

/**
 * Guest pages are link-access, locked to the first browser: the first view
 * binds the page to this browser's viewer cookie, irrevocably; every other
 * browser gets the lockout page. A bearer of the owning guest token bypasses
 * the lock entirely (handled by the caller); sessions play no part here.
 */
async function serveGuestPageToBrowser(
  c: Ctx,
  page: PageRow,
  serve: () => Promise<Response>,
): Promise<Response> {
  const cookie = getCookie(c, VIEWER_COOKIE);
  const viewerId = cookie ?? randomToken();
  const winner = await bindViewer(
    c.env.DB,
    page.uuid,
    viewerId,
    new Date().toISOString(),
  );
  if (winner !== viewerId) {
    return c.html(LOCKOUT_HTML, 403);
  }
  if (cookie === undefined) {
    setCookie(c, VIEWER_COOKIE, viewerId, {
      path: "/",
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      maxAge: VIEWER_COOKIE_MAX_AGE_S,
    });
  }
  return serve();
}

serveApp.get("/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  if (!isValidUuid(uuid)) return c.notFound();

  const page = await c.env.DB.prepare("SELECT * FROM pages WHERE uuid = ?")
    .bind(uuid.toLowerCase())
    .first<PageRow>();
  if (page === null) return c.notFound();

  const serve = async (): Promise<Response> => {
    if (page.current_revision === null) return c.notFound();
    const html = await getRevisionHtml(
      c.env.PAGES_BUCKET,
      page.uuid,
      page.current_revision,
      (promise) => c.executionCtx.waitUntil(promise),
    );
    if (html === null) return c.notFound();
    // A page view is a visit for free-tier expiry (harmless no-op for the
    // guest tier's fixed TTL).
    refreshLastVisited(c.env.DB, c.executionCtx, page);
    return c.body(html, 200, pageSecurityHeaders(page.sharing_mode));
  };

  if (page.sharing_mode === "public") return serve();

  const authHeader = c.req.header("Authorization");
  if (await isGuestOwner(c.env.DB, page.owner_id)) {
    // API requests with the owning guest token bypass the viewer lock; any
    // other bearer is a foreign API caller.
    if (authHeader !== undefined) {
      const identity = await identityFromRequest(c.env, authHeader);
      if (identity === null) return c.text("Authentication required", 401);
      if (identity.userId !== page.owner_id) {
        return c.text("Access denied", 403);
      }
      return serve();
    }
    return serveGuestPageToBrowser(c, page, serve);
  }

  // API clients authenticate with the same bearer credential as the API;
  // browsers use the host-only session cookie established by /auth/callback.
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
  return serve();
});

serveApp.notFound((c) => c.text("Not found", 404));
