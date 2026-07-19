import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { GUEST_TOKEN_PREFIX, guestIdentityFromToken } from "../lib/guests";
import { problems } from "../lib/problems";
import { identityFromAccessToken } from "../lib/workos";

export interface Identity {
  userId: string;
  /** Verified email address, when the identity has one. */
  email: string | null;
  /** Set when the identity is an anonymous-publishing guest account. */
  guest?: boolean;
}

export interface AuthVariables {
  identity: Identity;
}

/**
 * DEV AUTH STUB — active only when AUTH_MODE=dev-stub (tests, local dev).
 * The bearer token itself is treated as the caller's identity:
 *
 *   Authorization: Bearer user-1            -> userId "user-1", no email
 *   Authorization: Bearer alex@example.com  -> userId "alex@example.com",
 *                                              verified email "alex@example.com"
 *
 * An email-shaped token doubles as a verified email so `specific_users`
 * sharing is exercisable end to end.
 */
function devStubIdentity(token: string): Identity {
  return {
    userId: token,
    email: token.includes("@") ? token.toLowerCase() : null,
  };
}

/** Extract the bearer token from an Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
}

/**
 * Derive the caller's identity from an Authorization header, or null when
 * absent/malformed/unverifiable. In the real mode the bearer credential is a
 * WorkOS AuthKit access token verified against WorkOS's JWKS. Single source
 * of truth for API identity; both the API middleware and the hosted-page
 * origin use it.
 */
export async function identityFromRequest(
  env: Env,
  header: string | undefined,
): Promise<Identity | null> {
  const token = bearerToken(header);
  if (token === null) return null;
  // Guest tokens carry a reserved prefix and resolve against D1 in every
  // auth mode; they are minted by unauthenticated POST /v1/pages.
  if (token.startsWith(GUEST_TOKEN_PREFIX)) {
    return guestIdentityFromToken(env.DB, token);
  }
  if (env.AUTH_MODE === "dev-stub") return devStubIdentity(token);
  return identityFromAccessToken(env, token);
}

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const identity = await identityFromRequest(
    c.env,
    c.req.header("Authorization"),
  );
  if (identity === null) {
    return problems.unauthorized(c, "A valid bearer token is required.");
  }
  c.set("identity", identity);
  await next();
});
