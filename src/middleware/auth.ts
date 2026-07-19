import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { problems } from "../lib/problems";

/**
 * DEV AUTH STUB — replace with WorkOS AuthKit integration.
 *
 * The real system authenticates bearer credentials against WorkOS and derives
 * the user id and verified email from the WorkOS user. Until that lands, the
 * bearer token itself is treated as the caller's identity:
 *
 *   Authorization: Bearer user-1            -> userId "user-1", no email
 *   Authorization: Bearer alex@example.com  -> userId "alex@example.com",
 *                                              verified email "alex@example.com"
 *
 * An email-shaped token doubles as a verified email so `specific_users`
 * sharing is exercisable end to end. Nothing about routes, storage, or
 * authorization logic depends on this representation beyond `Identity`.
 */
export interface Identity {
  userId: string;
  /** Verified email address, when the identity has one. */
  email: string | null;
}

export interface AuthVariables {
  identity: Identity;
}

/**
 * Derive the caller's identity from an Authorization header, or null when
 * absent/malformed. Single source of truth for the dev-stub token semantics;
 * both the API middleware and the hosted-page origin use it.
 */
export function identityFromBearer(
  header: string | undefined,
): Identity | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) return null;
  return {
    userId: token,
    email: token.includes("@") ? token.toLowerCase() : null,
  };
}

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: AuthVariables;
}>(async (c, next) => {
  const identity = identityFromBearer(c.req.header("Authorization"));
  if (identity === null) {
    return problems.unauthorized(c, "A bearer token is required.");
  }
  c.set("identity", identity);
  await next();
});
