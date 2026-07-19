import type { Identity } from "../middleware/auth";
import { randomToken } from "./signing";

/**
 * Guest accounts and the browser viewer lock for anonymous publishing
 * (ARCHITECTURE.md "Anonymous publishing").
 */

/** Bearer tokens with this prefix are guest tokens, never WorkOS JWTs. */
export const GUEST_TOKEN_PREFIX = "pp_guest_";
/** Guest owner ids carry this prefix (WorkOS ids are `user_...`). */
export const GUEST_ID_PREFIX = "guest_";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface MintedGuest {
  guestId: string;
  /** The bearer token, returned to the client exactly once. */
  token: string;
}

/** Create a guest account; only the token's SHA-256 hash is stored. */
export async function mintGuest(
  db: D1Database,
  now: string,
): Promise<MintedGuest> {
  const guestId = `${GUEST_ID_PREFIX}${crypto.randomUUID()}`;
  const token = `${GUEST_TOKEN_PREFIX}${randomToken()}`;
  await db
    .prepare("INSERT INTO guests (id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(guestId, await sha256Hex(token), now)
    .run();
  return { guestId, token };
}

/** Resolve a guest bearer token to its identity, or null. */
export async function guestIdentityFromToken(
  db: D1Database,
  token: string,
): Promise<Identity | null> {
  const row = await db
    .prepare("SELECT id FROM guests WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string }>();
  if (row === null) return null;
  return { userId: row.id, email: null, guest: true };
}

/**
 * Which of these owner ids are real guest accounts? Prefix-gates first so
 * owners that can't possibly be guests never cost a D1 round-trip — this
 * matters on hot paths like page-view auth. Verifies the rest against D1.
 */
export async function resolveGuestOwnerIds(
  db: D1Database,
  ownerIds: string[],
): Promise<Set<string>> {
  const candidates = ownerIds.filter((id) => id.startsWith(GUEST_ID_PREFIX));
  if (candidates.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT id FROM guests WHERE id IN (${candidates.map(() => "?").join(", ")})`,
    )
    .bind(...candidates)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Is this owner id a guest account? The id prefix gates the D1 lookup so
 * regular pages never pay for it.
 */
export async function isGuestOwner(
  db: D1Database,
  ownerId: string,
): Promise<boolean> {
  const guestIds = await resolveGuestOwnerIds(db, [ownerId]);
  return guestIds.has(ownerId);
}

/**
 * Bind a guest page to a viewer id, first browser wins. Returns the winning
 * viewer id: `viewerId` itself when this call (or an earlier visit from the
 * same browser) holds the binding, or the other browser's id otherwise.
 */
export async function bindViewer(
  db: D1Database,
  pageUuid: string,
  viewerId: string,
  now: string,
): Promise<string> {
  const results = await db.batch<{ viewer_id: string }>([
    db
      .prepare(
        `INSERT INTO page_viewers (page_uuid, viewer_id, bound_at)
         VALUES (?, ?, ?) ON CONFLICT (page_uuid) DO NOTHING`,
      )
      .bind(pageUuid, viewerId, now),
    db
      .prepare("SELECT viewer_id FROM page_viewers WHERE page_uuid = ?")
      .bind(pageUuid),
  ]);
  const winner = results[1]?.results[0]?.viewer_id;
  if (winner === undefined) throw new Error("viewer binding vanished");
  return winner;
}
