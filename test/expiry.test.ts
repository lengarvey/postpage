import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runExpirySweep } from "../src/lib/expiry";
import { API, authed, createPage, setSharing } from "./helpers";

const HTML = "<!doctype html><html><body>expiry</body></html>";
const PAGES = "https://pages.postpage.ai";
const DAY_MS = 24 * 60 * 60_000;

function daysAgo(days: number, from = new Date()): Date {
  return new Date(from.getTime() - days * DAY_MS);
}

async function backdateVisit(uuid: string, days: number): Promise<void> {
  await env.DB.prepare("UPDATE pages SET last_visited_at = ? WHERE uuid = ?")
    .bind(daysAgo(days).toISOString().slice(0, 10), uuid)
    .run();
}

async function pageRow(uuid: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM pages WHERE uuid = ?").bind(uuid).first();
}

async function r2Keys(uuid: string): Promise<string[]> {
  const listing = await env.PAGES_BUCKET.list({ prefix: `pages/${uuid}/` });
  return listing.objects.map((o) => o.key);
}

/** Retry until `check` passes, for effects that run via waitUntil. */
async function eventually(check: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await check();
      return;
    } catch (error) {
      if (i >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function publishAnonymously(): Promise<{ uuid: string; guest_token: string; owner: string }> {
  const res = await SELF.fetch(`${API}/v1/pages`, {
    method: "POST",
    headers: { "Content-Type": "text/html", "CF-Connecting-IP": "192.0.2.99" },
    body: HTML,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { uuid: string; guest_token: string };
  const row = await pageRow(body.uuid);
  return { ...body, owner: row!.owner_id as string };
}

describe("expires_at", () => {
  it("computes free-tier expiry from last_visited_at and hides it for paid", async () => {
    const page = await createPage("free-user", HTML);
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("free-user", { headers: { Accept: "application/json" } }),
    );
    const body = (await res.json()) as { expires_at: string | null };
    const today = new Date().toISOString().slice(0, 10);
    expect(body.expires_at).toBe(
      new Date(Date.parse(`${today}T00:00:00.000Z`) + 90 * DAY_MS).toISOString(),
    );

    // A paid owner has no expiry.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (workos_user_id, email, email_verified, plan, created_at, updated_at)
       VALUES ('paid-user', 'paid@example.com', 1, 'paid', ?1, ?1)`,
    )
      .bind(now)
      .run();
    const paidPage = await createPage("paid-user", HTML);
    const paidRes = await SELF.fetch(
      `${API}/v1/pages/${paidPage.uuid}`,
      authed("paid-user", { headers: { Accept: "application/json" } }),
    );
    expect(((await paidRes.json()) as { expires_at: unknown }).expires_at).toBeNull();

    // And list JSON carries the field too.
    const list = await SELF.fetch(`${API}/v1/pages`, authed("free-user"));
    const { pages } = (await list.json()) as {
      pages: { expires_at: string | null }[];
    };
    expect(pages[0]!.expires_at).not.toBeNull();
  });
});

describe("last_visited_at refresh", () => {
  it("refreshes on a browser page view when stale, via waitUntil", async () => {
    const page = await createPage("visit-user", HTML);
    await setSharing("visit-user", page.uuid, { sharing_mode: "public" });
    await backdateVisit(page.uuid, 30);

    expect((await SELF.fetch(`${PAGES}/${page.uuid}`)).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    await eventually(async () => {
      const row = await pageRow(page.uuid);
      expect(row!.last_visited_at).toBe(today);
    });
  });

  it("refreshes on an authorized API content read", async () => {
    const page = await createPage("visit-user", HTML);
    await backdateVisit(page.uuid, 30);

    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("visit-user", { headers: { Accept: "text/html" } }),
    );
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    await eventually(async () => {
      const row = await pageRow(page.uuid);
      expect(row!.last_visited_at).toBe(today);
    });
  });
});

describe("expiry sweep (cron)", () => {
  it("deletes free-tier pages unvisited for 3 months, keeping active and paid pages", async () => {
    const stale = await createPage("sweep-user", HTML);
    const fresh = await createPage("sweep-user", HTML);
    await backdateVisit(stale.uuid, 91);
    await backdateVisit(fresh.uuid, 89);

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (workos_user_id, email, email_verified, plan, created_at, updated_at)
       VALUES ('sweep-paid', 'sp@example.com', 1, 'paid', ?1, ?1)`,
    )
      .bind(now)
      .run();
    const paid = await createPage("sweep-paid", HTML);
    await backdateVisit(paid.uuid, 400);

    await runExpirySweep(env, new Date());

    expect(await pageRow(stale.uuid)).toBeNull();
    expect(await pageRow(fresh.uuid)).not.toBeNull();
    expect(await pageRow(paid.uuid)).not.toBeNull();

    // Two-phase deletion completed: tombstone written, R2 purged, queue empty.
    const tombstone = await env.DB.prepare(
      "SELECT * FROM tombstones WHERE uuid = ?",
    )
      .bind(stale.uuid)
      .first();
    expect(tombstone).not.toBeNull();
    expect(await r2Keys(stale.uuid)).toEqual([]);
    const queued = await env.DB.prepare(
      "SELECT * FROM r2_purge_queue WHERE page_uuid = ?",
    )
      .bind(stale.uuid)
      .first();
    expect(queued).toBeNull();
  });

  it("deletes guest pages 1 week after publish and sweeps emptied guests", async () => {
    const guest = await publishAnonymously();
    // Backdate publish and guest creation past the TTL.
    const old = daysAgo(8).toISOString();
    await env.DB.prepare("UPDATE pages SET created_at = ? WHERE uuid = ?")
      .bind(old, guest.uuid)
      .run();
    await env.DB.prepare("UPDATE guests SET created_at = ? WHERE id = ?")
      .bind(old, guest.owner)
      .run();

    await runExpirySweep(env, new Date());

    expect(await pageRow(guest.uuid)).toBeNull();
    expect(await r2Keys(guest.uuid)).toEqual([]);
    const guestRow = await env.DB.prepare("SELECT * FROM guests WHERE id = ?")
      .bind(guest.owner)
      .first();
    expect(guestRow).toBeNull();

    // The swept guest's token no longer authenticates.
    const res = await SELF.fetch(`${API}/v1/pages`, authed(guest.guest_token));
    expect(res.status).toBe(401);
  });

  it("keeps guests (and their pages) inside the 1-week window", async () => {
    const guest = await publishAnonymously();
    await runExpirySweep(env, new Date());
    expect(await pageRow(guest.uuid)).not.toBeNull();
    const guestRow = await env.DB.prepare("SELECT * FROM guests WHERE id = ?")
      .bind(guest.owner)
      .first();
    expect(guestRow).not.toBeNull();
  });

  it("purges R2 objects left marked by a crashed run", async () => {
    // Simulate phase 1 done, phase 2 crashed: rows gone, object + queue left.
    const uuid = crypto.randomUUID();
    await env.PAGES_BUCKET.put(`pages/${uuid}/00000001.html`, HTML);
    await env.DB.prepare(
      "INSERT INTO r2_purge_queue (page_uuid, enqueued_at) VALUES (?, ?)",
    )
      .bind(uuid, new Date().toISOString())
      .run();

    await runExpirySweep(env, new Date());
    expect(await r2Keys(uuid)).toEqual([]);
  });

  it("isolates a persistently-failing purge so it can't block later rows or the guest sweep", async () => {
    const badUuid = crypto.randomUUID();
    const goodUuid = crypto.randomUUID();
    await env.PAGES_BUCKET.put(`pages/${badUuid}/00000001.html`, HTML);
    await env.PAGES_BUCKET.put(`pages/${goodUuid}/00000001.html`, HTML);
    // Queue the failing row first so it sorts ahead of the good row.
    await env.DB.prepare(
      "INSERT INTO r2_purge_queue (page_uuid, enqueued_at) VALUES (?, ?)",
    )
      .bind(badUuid, new Date(Date.now() - 1000).toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO r2_purge_queue (page_uuid, enqueued_at) VALUES (?, ?)",
    )
      .bind(goodUuid, new Date().toISOString())
      .run();

    // A guest whose only page is already gone; sweepEmptyGuests should still
    // reach it even though the purge queue has a permanently broken row.
    const swept = await publishAnonymously();
    await env.DB.prepare("DELETE FROM pages WHERE uuid = ?")
      .bind(swept.uuid)
      .run();
    await env.DB.prepare("UPDATE guests SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2 * DAY_MS).toISOString(), swept.owner)
      .run();

    const realList = env.PAGES_BUCKET.list.bind(env.PAGES_BUCKET);
    const listSpy = vi
      .spyOn(env.PAGES_BUCKET, "list")
      .mockImplementation((options?: R2ListOptions) => {
        if (
          typeof options === "object" &&
          options?.prefix === `pages/${badUuid}/`
        ) {
          throw new Error("simulated persistent R2 failure");
        }
        return realList(options);
      });

    try {
      await expect(runExpirySweep(env, new Date())).resolves.toBeUndefined();
    } finally {
      listSpy.mockRestore();
    }

    // The bad row is left queued for retry, not silently dropped...
    expect(await r2Keys(badUuid)).not.toEqual([]);
    const badQueued = await env.DB.prepare(
      "SELECT * FROM r2_purge_queue WHERE page_uuid = ?",
    )
      .bind(badUuid)
      .first();
    expect(badQueued).not.toBeNull();

    // ...but the row queued after it still gets purged...
    expect(await r2Keys(goodUuid)).toEqual([]);
    const goodQueued = await env.DB.prepare(
      "SELECT * FROM r2_purge_queue WHERE page_uuid = ?",
    )
      .bind(goodUuid)
      .first();
    expect(goodQueued).toBeNull();

    // ...and the guest sweep, which runs after the purge queue, still ran.
    const guestRow = await env.DB.prepare("SELECT * FROM guests WHERE id = ?")
      .bind(swept.owner)
      .first();
    expect(guestRow).toBeNull();
  });
});

describe("markPagesDeleted chunking", () => {
  it("marks every page deleted across a sweep large enough to need multiple db.batch() chunks", async () => {
    // Inserted directly rather than via createPage/HTTP to keep this fast:
    // 260 doomed pages spread across both expiry categories (200 free-tier +
    // 60 guest), enough to exceed a single MARK_CHUNK_SIZE (100) chunk and
    // guard against a regression to one giant db.batch() call, which risks
    // outright rejection by D1's batch limits and would stall the sweep
    // indefinitely (nothing shrinks the backlog on failure).
    const now = new Date();
    const nowIso = now.toISOString();
    const staleDay = new Date(now.getTime() - 91 * DAY_MS).toISOString().slice(0, 10);

    const freeUuids = Array.from({ length: 200 }, () => crypto.randomUUID());
    const freeInserts = freeUuids.map((uuid) =>
      env.DB.prepare(
        `INSERT INTO pages
           (uuid, owner_id, current_revision, next_revision, sharing_mode,
            created_at, updated_at, last_visited_at)
         VALUES (?1, 'mass-free-owner', 1, 2, 'private', ?2, ?2, ?3)`,
      ).bind(uuid, nowIso, staleDay),
    );

    const guestUuids = Array.from({ length: 60 }, () => crypto.randomUUID());
    const guestOldCreated = new Date(now.getTime() - 8 * DAY_MS).toISOString();
    const guestInserts = guestUuids.flatMap((uuid) => {
      const guestId = crypto.randomUUID();
      return [
        env.DB.prepare(
          "INSERT INTO guests (id, token_hash, created_at) VALUES (?1, ?2, ?3)",
        ).bind(guestId, `hash-${uuid}`, guestOldCreated),
        env.DB.prepare(
          `INSERT INTO pages
             (uuid, owner_id, current_revision, next_revision, sharing_mode,
              created_at, updated_at, last_visited_at)
           VALUES (?1, ?2, 1, 2, 'private', ?3, ?3, ?4)`,
        ).bind(uuid, guestId, guestOldCreated, guestOldCreated.slice(0, 10)),
      ];
    });

    // D1's own batch limits apply to this setup batch too, so chunk it.
    const allInserts = [...freeInserts, ...guestInserts];
    for (let i = 0; i < allInserts.length; i += 100) {
      await env.DB.batch(allInserts.slice(i, i + 100));
    }

    const allUuids = [...freeUuids, ...guestUuids];
    expect(allUuids.length).toBeGreaterThan(250);

    await runExpirySweep(env, now);

    for (const uuid of allUuids) {
      expect(await pageRow(uuid)).toBeNull();
      const tombstone = await env.DB.prepare(
        "SELECT * FROM tombstones WHERE uuid = ?",
      )
        .bind(uuid)
        .first();
      expect(tombstone).not.toBeNull();
    }

    // Purge queue was populated by phase 1 and then drained by the sweep's
    // own purge step, confirming the chunked batches actually committed.
    const remainingQueued = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM r2_purge_queue WHERE page_uuid IN (SELECT value FROM json_each(?1))",
    )
      .bind(JSON.stringify(allUuids))
      .first<{ n: number }>();
    expect(remainingQueued?.n).toBe(0);
  });
});

describe("DELETE endpoint two-phase deletion", () => {
  it("removes rows immediately and purges R2 off the request path", async () => {
    const page = await createPage("del-user", HTML);
    const res = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("del-user"),
    });
    expect(res.status).toBe(204);
    expect(await pageRow(page.uuid)).toBeNull();
    await eventually(async () => {
      expect(await r2Keys(page.uuid)).toEqual([]);
      const queued = await env.DB.prepare(
        "SELECT * FROM r2_purge_queue WHERE page_uuid = ?",
      )
        .bind(page.uuid)
        .first();
      expect(queued).toBeNull();
    });
  });
});
