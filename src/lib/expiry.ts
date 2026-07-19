import type { Env } from "../env";
import { markPagesDeleted, purgePageObjects, type PageRow } from "./pages";
import { FREE_PAGE_EXPIRY_DAYS, GUEST_PAGE_TTL_DAYS } from "./plans";
import { utcDay } from "./quota";

/**
 * Daily expiry sweep (ARCHITECTURE.md "Plans, quotas, and expiry"), run from
 * the Worker's `scheduled` handler. Every step is bounded and idempotent, so
 * a crashed or slow run simply leaves work for the next one.
 */

/** Maximum pages marked per category per run. */
const SWEEP_BATCH = 200;
/**
 * Maximum queued R2 purges processed per run. Set well above 2x SWEEP_BATCH
 * (the most a single run can enqueue, across both categories) so one run can
 * always drain what it just enqueued plus make headway on any prior backlog,
 * instead of the queue growing under sustained expiry.
 */
const PURGE_BATCH = 600;

const DAY_MS = 24 * 60 * 60_000;

type DoomedPage = Pick<PageRow, "uuid" | "owner_id">;

/**
 * Free-tier pages unvisited for FREE_PAGE_EXPIRY_DAYS. Owners without a
 * users row (possible under the dev auth stub) count as free; paid owners
 * are excluded; guest pages are handled by the fixed TTL below.
 */
async function expiredFreePages(db: D1Database, now: Date): Promise<DoomedPage[]> {
  const cutoffDay = utcDay(new Date(now.getTime() - FREE_PAGE_EXPIRY_DAYS * DAY_MS));
  const { results } = await db
    .prepare(
      `SELECT p.uuid, p.owner_id FROM pages p
       WHERE p.last_visited_at < ?1
         AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.id = p.owner_id)
         AND COALESCE(
           (SELECT u.plan FROM users u WHERE u.workos_user_id = p.owner_id),
           'free') = 'free'
       LIMIT ?2`,
    )
    .bind(cutoffDay, SWEEP_BATCH)
    .all<DoomedPage>();
  return results;
}

/** Guest pages past the fixed 1-week TTL from publish. */
async function expiredGuestPages(db: D1Database, now: Date): Promise<DoomedPage[]> {
  const cutoff = new Date(now.getTime() - GUEST_PAGE_TTL_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT p.uuid, p.owner_id FROM pages p
       JOIN guests g ON g.id = p.owner_id
       WHERE p.created_at < ?1
       LIMIT ?2`,
    )
    .bind(cutoff, SWEEP_BATCH)
    .all<DoomedPage>();
  return results;
}

/**
 * Purge R2 objects for pages marked deleted, dropping each queue row after.
 * Each purge is isolated: a persistently-failing row is logged and skipped
 * rather than aborting the batch, so it can't starve every row queued after
 * it (or the rest of the sweep) run after run. It stays queued and is
 * retried on the next run, same as a mid-purge crash.
 */
async function processPurgeQueue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT page_uuid FROM r2_purge_queue ORDER BY enqueued_at LIMIT ?",
  )
    .bind(PURGE_BATCH)
    .all<{ page_uuid: string }>();
  for (const row of results) {
    try {
      await purgePageObjects(env, row.page_uuid);
    } catch (error) {
      console.error(`purgePageObjects failed for ${row.page_uuid}`, error);
    }
  }
}

/**
 * Sweep guest accounts whose pages have all expired (i.e. that own no pages
 * anymore). The 1-day grace shields a just-minted guest whose first page
 * insert is still in flight.
 */
async function sweepEmptyGuests(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  await db
    .prepare(
      `DELETE FROM guests
       WHERE created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.owner_id = guests.id)`,
    )
    .bind(cutoff)
    .run();
}

/** One full sweep: mark expired pages, purge queued R2 objects, sweep guests. */
export async function runExpirySweep(env: Env, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const doomed = [
    ...(await expiredFreePages(env.DB, now)),
    ...(await expiredGuestPages(env.DB, now)),
  ];
  await markPagesDeleted(env.DB, doomed, nowIso);
  await processPurgeQueue(env);
  await sweepEmptyGuests(env.DB, now);
}
