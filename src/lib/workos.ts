import type { WorkOS } from "@workos-inc/node";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { Env } from "../env";
import type { Identity } from "../middleware/auth";

export interface WorkosConfig {
  apiKey: string;
  clientId: string;
}

/** WorkOS credentials from the environment, or null when not configured. */
export function workosConfig(env: Env): WorkosConfig | null {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID) return null;
  return { apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID };
}

let cachedClient: { clientId: string; client: WorkOS } | undefined;

/**
 * WorkOS SDK client. Imported lazily so the dev-stub path (tests, local dev)
 * never loads the SDK; cached per isolate.
 */
export async function workosClient(env: Env): Promise<WorkOS> {
  const config = workosConfig(env);
  if (config === null) {
    throw new Error(
      "WorkOS is not configured: set WORKOS_API_KEY and WORKOS_CLIENT_ID",
    );
  }
  if (cachedClient?.clientId !== config.clientId) {
    const { WorkOS } = await import("@workos-inc/node");
    cachedClient = {
      clientId: config.clientId,
      client: new WorkOS(config.apiKey, { clientId: config.clientId }),
    };
  }
  return cachedClient.client;
}

/** Issuer of tokens minted through the WorkOS API (SDKs, CLI device flow). */
const WORKOS_API_ISSUER = "https://api.workos.com";

/** The configured AuthKit issuer origin, trimmed and without a trailing
 * slash. Single source of truth for both token verification and the issuer
 * advertised by the MCP discovery metadata. */
export function authkitIssuer(env: Env): string | null {
  const domain = env.WORKOS_AUTHKIT_DOMAIN?.trim();
  if (!domain) return null;
  return domain.replace(/\/+$/, "");
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFromUrl(env: Env, url: string): JWTVerifyGetKey {
  // Test-only local JWKS override; production always uses the live endpoint.
  const cacheKey = env.WORKOS_JWKS ?? url;
  let jwks = jwksCache.get(cacheKey);
  if (jwks === undefined) {
    jwks = env.WORKOS_JWKS
      ? createLocalJWKSet(JSON.parse(env.WORKOS_JWKS))
      : createRemoteJWKSet(new URL(url));
    jwksCache.set(cacheKey, jwks);
  }
  return jwks;
}

/**
 * Verify a bearer credential as a WorkOS-issued access token and resolve it
 * to an Identity. Returns null for anything that does not verify. Clients
 * obtain and refresh tokens through WorkOS; Postpage only verifies them.
 *
 * WorkOS issues two token families, distinguished by (allowlisted) issuer,
 * each verified against its own JWKS — the allowlist decides which JWKS to
 * trust, never the token itself:
 *
 *  - `https://api.workos.com[/...]`: SDK / CLI-device-flow tokens, signed by
 *    the keys at api.workos.com/sso/jwks/{clientId}.
 *  - The configured AuthKit domain: tokens minted by AuthKit acting as an
 *    OAuth authorization server (the MCP connector flow), signed by the keys
 *    at {authkit domain}/oauth2/jwks.
 *
 * Tokens with any other issuer — or none — are rejected outright.
 */
export async function identityFromAccessToken(
  env: Env,
  token: string,
): Promise<Identity | null> {
  const config = workosConfig(env);
  if (config === null) {
    throw new Error(
      "WorkOS is not configured: set WORKOS_API_KEY and WORKOS_CLIENT_ID " +
        "(or AUTH_MODE=dev-stub for local development)",
    );
  }

  // Route on the *unverified* issuer claim, but only ever to an allowlisted
  // (issuer, JWKS) pair; jwtVerify then re-checks the issuer on the verified
  // payload. A forged issuer selects nothing.
  let issuer: string;
  let jwksUrl: string;
  try {
    const iss = decodeJwt(token).iss;
    if (typeof iss !== "string") return null;
    const authkit = authkitIssuer(env);
    if (iss === WORKOS_API_ISSUER || iss.startsWith(`${WORKOS_API_ISSUER}/`)) {
      issuer = iss;
      jwksUrl = `${WORKOS_API_ISSUER}/sso/jwks/${config.clientId}`;
    } else if (authkit !== null && iss === authkit) {
      issuer = authkit;
      jwksUrl = `${authkit}/oauth2/jwks`;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(token, jwksFromUrl(env, jwksUrl), {
      issuer,
    });
    sub = payload.sub;
  } catch {
    return null;
  }
  if (!sub) return null;
  return identityForWorkosUser(env, sub);
}

interface UserRow {
  email: string;
  email_verified: number;
}

/**
 * Resolve a WorkOS user id to an Identity via the D1 user cache, fetching the
 * user from WorkOS on first sight. `email` is only populated when WorkOS
 * reports it verified — sharing by email must never trust unverified
 * addresses.
 */
export async function identityForWorkosUser(
  env: Env,
  workosUserId: string,
): Promise<Identity | null> {
  const row = await env.DB.prepare(
    "SELECT email, email_verified FROM users WHERE workos_user_id = ?",
  )
    .bind(workosUserId)
    .first<UserRow>();
  if (row !== null) {
    return {
      userId: workosUserId,
      email: row.email_verified ? row.email : null,
    };
  }

  const workos = await workosClient(env);
  let user;
  try {
    user = await workos.userManagement.getUser(workosUserId);
  } catch {
    // A token whose user no longer exists in WorkOS is not a valid identity.
    return null;
  }
  await upsertUser(env.DB, user.id, user.email, user.emailVerified);
  return {
    userId: user.id,
    email: user.emailVerified ? user.email.toLowerCase() : null,
  };
}

/** Insert or refresh the cached WorkOS user record. */
export async function upsertUser(
  db: D1Database,
  workosUserId: string,
  email: string,
  emailVerified: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (workos_user_id, email, email_verified, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (workos_user_id) DO UPDATE
         SET email = ?2, email_verified = ?3, updated_at = ?4`,
    )
    .bind(workosUserId, email.toLowerCase(), emailVerified ? 1 : 0, now)
    .run();
}
