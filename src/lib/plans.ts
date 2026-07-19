import { GUEST_ID_PREFIX, resolveGuestOwnerIds } from "./guests";
import type { PageRow } from "./pages";

/**
 * Plan resolution and computed expiry (ARCHITECTURE.md "Plans, quotas, and
 * expiry"). "anonymous" is the implicit plan of guest owners; signed-in
 * owners default to "free" until a users row says otherwise.
 */
export type Plan = "anonymous" | "free" | "paid";

/** Guest pages are deleted this many days after publish (fixed, 1 week). */
export const GUEST_PAGE_TTL_DAYS = 7;
/** Free-tier pages are deleted after this many days without a visit (~3 months). */
export const FREE_PAGE_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60_000;

/** Resolve owner ids to plans in two batched queries, keyed by owner id. */
export async function getOwnerPlans(
  db: D1Database,
  ownerIds: string[],
): Promise<Map<string, Plan>> {
  const plans = new Map<string, Plan>();
  const unique = [...new Set(ownerIds)];
  for (const id of unique) plans.set(id, "free");

  const userIds = unique.filter((id) => !id.startsWith(GUEST_ID_PREFIX));
  const guestIds = await resolveGuestOwnerIds(db, unique);
  for (const id of guestIds) plans.set(id, "anonymous");
  if (userIds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT workos_user_id, plan FROM users
         WHERE workos_user_id IN (${userIds.map(() => "?").join(", ")})`,
      )
      .bind(...userIds)
      .all<{ workos_user_id: string; plan: string }>();
    for (const row of results) {
      plans.set(row.workos_user_id, row.plan === "paid" ? "paid" : "free");
    }
  }
  return plans;
}

/** Plan of a single owner id. */
export async function getOwnerPlan(
  db: D1Database,
  ownerId: string,
): Promise<Plan> {
  const plans = await getOwnerPlans(db, [ownerId]);
  return plans.get(ownerId) ?? "free";
}

/**
 * When this page will be deleted if nothing changes, or null on plans
 * without expiry. Guest pages: fixed TTL from publish. Free pages: the
 * expiry day derived from `last_visited_at`, so any visit pushes it out.
 */
export function computeExpiresAt(plan: Plan, page: PageRow): string | null {
  if (plan === "paid") return null;
  if (plan === "anonymous") {
    return new Date(
      Date.parse(page.created_at) + GUEST_PAGE_TTL_DAYS * DAY_MS,
    ).toISOString();
  }
  return new Date(
    Date.parse(`${page.last_visited_at}T00:00:00.000Z`) +
      FREE_PAGE_EXPIRY_DAYS * DAY_MS,
  ).toISOString();
}
