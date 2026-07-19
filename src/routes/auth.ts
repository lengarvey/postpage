import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import { HOSTNAME_PATTERN } from "../lib/names";
import { isValidUuid } from "../lib/pages";
import { randomToken, signState, verifyState } from "../lib/signing";
import { upsertUser, workosClient, workosConfig } from "../lib/workos";
import type { Identity } from "../middleware/auth";

/** How long the signed OAuth state (login attempt) stays valid. */
const STATE_MAX_AGE_MS = 10 * 60_000;
/** One-time handoff codes are redeemed within seconds; keep the window tight. */
const LOGIN_CODE_TTL_MS = 2 * 60_000;
/** Page-host session lifetime. */
const PAGE_SESSION_TTL_MS = 12 * 60 * 60_000;

export const SESSION_COOKIE = "pp_session";

type Ctx = Context<{ Bindings: Env }>;

/** Trusted apex origin (login endpoints live here). */
export function apexOrigin(env: Env): URL {
  return new URL(env.PAGES_URL_BASE || `https://${env.PAGES_DOMAIN}`);
}

interface PageTarget {
  /** Full page hostname, e.g. `amber-otter-k7.pages.postpage.ai`. */
  host: string;
  /** Exact `/s/{uuid}` path. */
  path: string;
  origin: string;
}

/**
 * Accept a post-login destination only if it is a canonical page URL on our
 * own pages domain: `{friendly}.{PAGES_DOMAIN}/s/{uuid}`. Everything else is
 * rejected so the login flow can never become an open redirect.
 */
export function parsePageTarget(env: Env, raw: string): PageTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const base = apexOrigin(env);
  if (url.protocol !== base.protocol || url.port !== base.port) return null;
  const suffix = `.${base.hostname}`;
  if (!url.hostname.endsWith(suffix)) return null;
  if (!HOSTNAME_PATTERN.test(url.hostname.slice(0, -suffix.length))) {
    return null;
  }
  const match = /^\/s\/([^/]+)$/.exec(url.pathname);
  if (match === null || !isValidUuid(match[1]!)) return null;
  return { host: url.hostname, path: url.pathname, origin: url.origin };
}

/** URL on the apex that starts a login for the given page URL. */
export function loginUrl(env: Env, pageUrl: string): string {
  const url = apexOrigin(env);
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
 * GET /auth/login?redirect={canonical page url} (trusted apex origin).
 * Sends the browser through WorkOS AuthKit; the destination survives the
 * round-trip inside a signed `state`.
 */
export async function authLogin(c: Ctx): Promise<Response> {
  const redirect = c.req.query("redirect") ?? "";
  const target = parsePageTarget(c.env, redirect);
  if (target === null) {
    return c.text("Invalid redirect", 400);
  }
  if (workosConfig(c.env) === null || !c.env.AUTH_SECRET) {
    return c.text("Login is not configured", 503);
  }

  const state = await signState(c.env.AUTH_SECRET, { r: redirect });
  const workos = await workosClient(c.env);
  const callback = apexOrigin(c.env);
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
 * GET /auth/callback?code&state (trusted apex origin). Exchanges the WorkOS
 * code, refreshes the user cache, and hands the destination page host a
 * one-time login code — never a shared cookie.
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
  const target = state === null ? null : parsePageTarget(c.env, state.r);
  if (target === null) {
    return c.text("Login request is invalid or expired", 400);
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

  const loginCode = randomToken();
  await c.env.DB.prepare(
    `INSERT INTO login_codes (code, workos_user_id, email, host, redirect_path, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      loginCode,
      user.id,
      user.emailVerified ? user.email.toLowerCase() : null,
      target.host,
      target.path,
      new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString(),
    )
    .run();

  const handoff = new URL(`${target.origin}/auth/session`);
  handoff.searchParams.set("code", loginCode);
  return c.redirect(handoff.toString(), 302);
}

interface LoginCodeRow {
  workos_user_id: string;
  email: string | null;
  host: string;
  redirect_path: string;
  expires_at: string;
}

/**
 * GET /auth/session?code (page-host origin). Redeems a one-time login code
 * minted for this exact hostname and sets the host-only session cookie. The
 * cookie carries no Domain attribute, so the browser never sends it to any
 * other page subdomain.
 */
export async function authSession(c: Ctx): Promise<Response> {
  const url = new URL(c.req.url);
  const code = c.req.query("code") ?? "";
  if (code === "") return c.text("Login link is invalid or expired", 401);

  // DELETE ... RETURNING makes redemption atomic: a code can win exactly once.
  const row = await c.env.DB.prepare(
    "DELETE FROM login_codes WHERE code = ? RETURNING *",
  )
    .bind(code)
    .first<LoginCodeRow>();
  if (
    row === null ||
    row.host !== url.hostname ||
    row.expires_at <= new Date().toISOString()
  ) {
    return c.text("Login link is invalid or expired", 401);
  }

  const now = Date.now();
  const sessionId = randomToken();
  await c.env.DB.prepare(
    `INSERT INTO page_sessions (id, host, workos_user_id, email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      row.host,
      row.workos_user_id,
      row.email,
      new Date(now).toISOString(),
      new Date(now + PAGE_SESSION_TTL_MS).toISOString(),
    )
    .run();

  setCookie(c, SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    maxAge: Math.floor(PAGE_SESSION_TTL_MS / 1000),
  });
  return c.redirect(row.redirect_path, 302);
}

interface SessionRow {
  workos_user_id: string;
  email: string | null;
  expires_at: string;
}

/**
 * Identity from this page host's session cookie, or null. Sessions are bound
 * to the exact hostname they were created for.
 */
export async function identityFromSession(c: Ctx): Promise<Identity | null> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  const host = new URL(c.req.url).hostname;
  const row = await c.env.DB.prepare(
    "SELECT workos_user_id, email, expires_at FROM page_sessions WHERE id = ? AND host = ?",
  )
    .bind(sessionId, host)
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
