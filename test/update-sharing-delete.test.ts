import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API, authed, createPage, setSharing } from "./helpers";
import { activateRevision, reserveRevision } from "../src/lib/pages";

const V1 = "<!doctype html><html><body>v1</body></html>";
const V2 = "<!doctype html><html><body>v2</body></html>";

async function putContent(token: string, uuid: string, html: string) {
  return SELF.fetch(`${API}/v1/pages/${uuid}`, {
    method: "PUT",
    ...authed(token, { headers: { "Content-Type": "text/html" } }),
    body: html,
  });
}

describe("PUT /v1/pages/{uuid}", () => {
  it("creates a new revision and serves the new bytes", async () => {
    const page = await createPage("user-1", V1);
    const res = await putContent("user-1", page.uuid, V2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.current_revision).toBe(2);

    const get = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1"),
    );
    expect(await get.text()).toBe(V2);

    // Both revision objects are retained. (head() avoids opening a body
    // stream, which would break vitest-pool-workers' storage isolation.)
    expect(await env.PAGES_BUCKET.head(`pages/${page.uuid}/00000001.html`)).not
      .toBeNull();
    expect(await env.PAGES_BUCKET.head(`pages/${page.uuid}/00000002.html`)).not
      .toBeNull();
  });

  it("creates a new revision even for identical bytes", async () => {
    const page = await createPage("user-1", V1);
    const res = await putContent("user-1", page.uuid, V1);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.current_revision).toBe(2);
  });

  it("rejects non-owners", async () => {
    const page = await createPage("user-1", V1);
    const res = await putContent("user-2", page.uuid, V2);
    expect(res.status).toBe(403);
  });

  it("validates uploads like create does", async () => {
    const page = await createPage("user-1", V1);
    const empty = await putContent("user-1", page.uuid, "");
    expect(empty.status).toBe(400);
    const wrongType = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "PUT",
      ...authed("user-1", { headers: { "Content-Type": "text/plain" } }),
      body: "hi",
    });
    expect(wrongType.status).toBe(415);
    // Failed updates leave the current revision unchanged.
    const get = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1", { headers: { Accept: "application/json" } }),
    );
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.current_revision).toBe(1);
  });

  it("never lets an older upload displace a newer active revision", async () => {
    const page = await createPage("user-1", V1);
    const older = await reserveRevision(env.DB, page.uuid); // 2
    const newer = await reserveRevision(env.DB, page.uuid); // 3
    expect([older, newer]).toEqual([2, 3]);

    const enc = new TextEncoder();
    const now = new Date().toISOString();
    // Newer upload completes first, older one lands afterwards.
    await activateRevision(env, page.uuid, newer, enc.encode(V2).buffer as ArrayBuffer, now);
    await activateRevision(env, page.uuid, older, enc.encode(V1).buffer as ArrayBuffer, now);

    const get = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1", { headers: { Accept: "application/json" } }),
    );
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.current_revision).toBe(3);
    expect(body.html).toBe(V2);
  });
});

describe("PUT /v1/pages/{uuid}/sharing", () => {
  it("makes a page public so any authenticated user can read it", async () => {
    const page = await createPage("user-1", V1);
    const res = await setSharing("user-1", page.uuid, {
      sharing_mode: "public",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sharing).toEqual({ sharing_mode: "public" });

    const other = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-2"),
    );
    expect(other.status).toBe(200);
  });

  it("grants access to listed verified emails only", async () => {
    const page = await createPage("user-1", V1);
    const res = await setSharing("user-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["Alex@Example.com", "sam@example.com"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sharing).toEqual({
      sharing_mode: "specific_users",
      emails: ["alex@example.com", "sam@example.com"],
    });

    // Email-shaped dev token == verified email.
    const alex = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("alex@example.com"),
    );
    expect(alex.status).toBe(200);

    const stranger = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("intruder@example.com"),
    );
    expect(stranger.status).toBe(403);
  });

  it("replaces the whole configuration", async () => {
    const page = await createPage("user-1", V1);
    await setSharing("user-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
    await setSharing("user-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["sam@example.com"],
    });

    // alex lost access when the config was replaced.
    const alex = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("alex@example.com"),
    );
    expect(alex.status).toBe(403);

    // Back to private clears the email list entirely.
    await setSharing("user-1", page.uuid, { sharing_mode: "private" });
    const { results } = await env.DB.prepare(
      "SELECT email FROM page_permissions WHERE page_uuid = ?",
    )
      .bind(page.uuid)
      .all();
    expect(results).toEqual([]);
  });

  it("rejects invalid configurations", async () => {
    const page = await createPage("user-1", V1);
    const cases: Array<Record<string, unknown>> = [
      { sharing_mode: "friends" },
      { sharing_mode: "specific_users" },
      { sharing_mode: "specific_users", emails: [] },
      { sharing_mode: "specific_users", emails: ["not-an-email"] },
      { sharing_mode: "public", emails: ["alex@example.com"] },
      { sharing_mode: "private", extra: true },
    ];
    for (const body of cases) {
      const res = await setSharing("user-1", page.uuid, body as never);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const problem = (await res.json()) as Record<string, unknown>;
      expect(problem.code).toBe("validation_error");
    }
  });

  it("rejects non-owners", async () => {
    const page = await createPage("user-1", V1);
    const res = await setSharing("user-2", page.uuid, {
      sharing_mode: "public",
    });
    expect(res.status).toBe(403);
  });

  it("does not change page identity or URLs", async () => {
    const page = await createPage("user-1", V1);
    const res = await setSharing("user-1", page.uuid, {
      sharing_mode: "public",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uuid).toBe(page.uuid);
    expect(body.hostname).toBe(page.hostname);
    expect(body.url).toBe(page.url);
  });
});

describe("DELETE /v1/pages/{uuid}", () => {
  it("removes the page, its revisions, and leaves a tombstone", async () => {
    const page = await createPage("user-1", V1);
    await putContent("user-1", page.uuid, V2);

    const res = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("user-1"),
    });
    expect(res.status).toBe(204);

    const get = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1"),
    );
    expect(get.status).toBe(404);

    // R2 objects purged.
    const listed = await env.PAGES_BUCKET.list({
      prefix: `pages/${page.uuid}/`,
    });
    expect(listed.objects).toEqual([]);

    // Tombstone retains uuid, hostname, owner, and deletion time.
    const tombstone = await env.DB.prepare(
      "SELECT * FROM tombstones WHERE uuid = ?",
    )
      .bind(page.uuid)
      .first<Record<string, unknown>>();
    expect(tombstone?.hostname).toBe(page.hostname);
    expect(tombstone?.owner_id).toBe("user-1");
    expect(tombstone?.deleted_at).toBeTruthy();

    // Metadata rows are gone.
    const revisions = await env.DB.prepare(
      "SELECT * FROM revisions WHERE page_uuid = ?",
    )
      .bind(page.uuid)
      .all();
    expect(revisions.results).toEqual([]);
  });

  it("rejects non-owners", async () => {
    const page = await createPage("user-1", V1);
    const res = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("user-2"),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an already-deleted page", async () => {
    const page = await createPage("user-1", V1);
    await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("user-1"),
    });
    const again = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("user-1"),
    });
    expect(again.status).toBe(404);
  });
});
