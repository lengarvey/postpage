import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import { isValidUuid } from "../lib/pages";
import { randomToken, signState, verifyState } from "../lib/signing";
import { upsertUser, workosClient, workosConfig } from "../lib/workos";
import type { Identity } from "../middleware/auth";

/** How long the signed OAuth state (login attempt) stays valid. */
const STATE_MAX_AGE_MS = 10 * 60_000;
/** Browser session lifetime. */
const PAGE_SESSION_TTL_MS = 12 * 60 * 60_000;

export const SESSION_COOKIE = "pp_session";

type Ctx = Context<{ Bindings: Env }>;

/** Serving origin: pages and the auth endpoints all live here. */
export function pagesOrigin(env: Env): URL {
  return new URL(env.PAGES_URL_BASE || `https://${env.PAGES_DOMAIN}`);
}

/**
 * Accept a post-login destination only if it is a canonical page URL on our
 * own serving origin: `{PAGES_DOMAIN}/{uuid}`. Everything else is rejected so
 * the login flow can never become an open redirect. Returns the `/{uuid}`
 * path to land on.
 */
export function parsePagePath(env: Env, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== pagesOrigin(env).origin) return null;
  const match = /^\/([^/]+)$/.exec(url.pathname);
  if (match === null || !isValidUuid(match[1]!)) return null;
  return url.pathname;
}

/** URL on the serving origin that starts a login for the given page URL. */
export function loginUrl(env: Env, pageUrl: string): string {
  const url = pagesOrigin(env);
  url.pathname = "/auth/login";
  url.searchParams.set("redirect", pageUrl);
  return url.toString();
}

interface LoginState {
  /** Canonical page URL to return to after authentication. */
  r: string;
  iat: number;
}

/**
 * GET /auth/login?redirect={canonical page url} (serving origin).
 * Sends the browser through WorkOS AuthKit; the destination survives the
 * round-trip inside a signed `state`.
 */
export async function authLogin(c: Ctx): Promise<Response> {
  const redirect = c.req.query("redirect") ?? "";
  if (parsePagePath(c.env, redirect) === null) {
    return c.text("Invalid redirect", 400);
  }
  if (workosConfig(c.env) === null || !c.env.AUTH_SECRET) {
    return c.text("Login is not configured", 503);
  }

  const state = await signState(c.env.AUTH_SECRET, { r: redirect });
  const workos = await workosClient(c.env);
  const callback = pagesOrigin(c.env);
  callback.pathname = "/auth/callback";
  const url = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: c.env.WORKOS_CLIENT_ID!,
    redirectUri: callback.toString(),
    state,
  });
  return c.redirect(url, 302);
}

/**
 * GET /auth/callback?code&state (serving origin). Exchanges the WorkOS code,
 * refreshes the user cache, and establishes the session cookie directly —
 * the callback and the pages share one origin, so no handoff is needed.
 */
export async function authCallback(c: Ctx): Promise<Response> {
  if (workosConfig(c.env) === null || !c.env.AUTH_SECRET) {
    return c.text("Login is not configured", 503);
  }
  const state = await verifyState<LoginState>(
    c.env.AUTH_SECRET,
    c.req.query("state") ?? "",
    STATE_MAX_AGE_MS,
  );
  const path = state === null ? null : parsePagePath(c.env, state.r);
  if (path === null) {
    // The signed return-destination is missing or stale (e.g. a login started
    // before a redeploy, or a sign-up detour that dropped `state`). The
    // AuthKit session itself may well have succeeded, so reopening the page
    // link restarts the round-trip without prompting again.
    return c.text(
      "This login link has expired. Open the page you were trying to view again to finish signing in.",
      400,
    );
  }
  const code = c.req.query("code");
  if (!code) {
    return c.text("Login failed", 401);
  }

  const workos = await workosClient(c.env);
  let user;
  try {
    ({ user } = await workos.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID!,
      code,
    }));
  } catch {
    return c.text("Login failed", 401);
  }
  await upsertUser(c.env.DB, user.id, user.email, user.emailVerified);

  await establishSession(c, {
    userId: user.id,
    email: user.emailVerified ? user.email.toLowerCase() : null,
  });
  return c.redirect(path, 302);
}

/**
 * Create a D1-backed session and set the host-only, HTTP-only cookie on the
 * serving origin. The cookie carries no Domain attribute and stores only the
 * random session id; identity lives in D1.
 */
export async function establishSession(
  c: Ctx,
  identity: Identity,
): Promise<void> {
  const now = Date.now();
  const sessionId = randomToken();
  await c.env.DB.prepare(
    `INSERT INTO page_sessions (id, workos_user_id, email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      identity.userId,
      identity.email,
      new Date(now).toISOString(),
      new Date(now + PAGE_SESSION_TTL_MS).toISOString(),
    )
    .run();

  setCookie(c, SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: Math.floor(PAGE_SESSION_TTL_MS / 1000),
  });
}

interface SessionRow {
  workos_user_id: string;
  email: string | null;
  expires_at: string;
}

/** Identity from the serving origin's session cookie, or null. */
export async function identityFromSession(c: Ctx): Promise<Identity | null> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  const row = await c.env.DB.prepare(
    "SELECT workos_user_id, email, expires_at FROM page_sessions WHERE id = ?",
  )
    .bind(sessionId)
    .first<SessionRow>();
  if (row === null) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await c.env.DB.prepare("DELETE FROM page_sessions WHERE id = ?")
      .bind(sessionId)
      .run();
    return null;
  }
  return { userId: row.workos_user_id, email: row.email };
}
