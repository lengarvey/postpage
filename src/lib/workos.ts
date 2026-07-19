import type { WorkOS } from "@workos-inc/node";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
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

let cachedJwks: { key: string; jwks: JWTVerifyGetKey } | undefined;

function jwks(env: Env, clientId: string): JWTVerifyGetKey {
  // Test-only local JWKS override; production always uses WorkOS's endpoint.
  const cacheKey = env.WORKOS_JWKS ?? clientId;
  if (cachedJwks?.key !== cacheKey) {
    cachedJwks = {
      key: cacheKey,
      jwks: env.WORKOS_JWKS
        ? createLocalJWKSet(JSON.parse(env.WORKOS_JWKS))
        : createRemoteJWKSet(
            new URL(`https://api.workos.com/sso/jwks/${clientId}`),
          ),
    };
  }
  return cachedJwks.jwks;
}

/**
 * Verify a bearer credential as a WorkOS AuthKit access token (a JWT signed
 * by WorkOS) and resolve it to an Identity. Returns null for anything that
 * does not verify. This is the "credential form WorkOS supports": clients
 * obtain and refresh tokens through WorkOS; Postpage only verifies them.
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
  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(token, jwks(env, config.clientId));
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
