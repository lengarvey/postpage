/**
 * Publish-quota accounting (ARCHITECTURE.md "Plans, quotas, and expiry").
 * One counter row per (key, UTC calendar day); the window is the UTC day,
 * not a rolling 24 hours. Deletes never refund.
 */

/** Daily page creations for a signed-in free-tier user. */
export const FREE_DAILY_LIMIT = 30;
/** Daily page creations per client IP for anonymous/guest publishing. */
export const ANONYMOUS_DAILY_LIMIT = 5;

/** UTC calendar day (YYYY-MM-DD) of an instant. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Atomically consume one unit of quota for `key` on `day`. Returns false
 * (without incrementing) when the counter already sits at `limit`.
 */
export async function consumeQuota(
  db: D1Database,
  key: string,
  day: string,
  limit: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (key, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1
         WHERE count < ?3
       RETURNING count`,
    )
    .bind(key, day, limit)
    .first<{ count: number }>();
  return row !== null;
}

/**
 * Undo one `consumeQuota` increment for `key` on `day`, for callers that
 * failed after consuming the unit (e.g. `createPage` throwing post-quota).
 * Guarded to never take the counter below zero, and a no-op if the row
 * doesn't exist (nothing to refund).
 */
export async function refundQuota(
  db: D1Database,
  key: string,
  day: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE usage_counters SET count = count - 1
       WHERE key = ?1 AND day = ?2 AND count > 0`,
    )
    .bind(key, day)
    .run();
}
