import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API, authed, createPage, setSharing } from "./helpers";

interface ListResponse {
  pages: Array<{ uuid: string; sharing: { sharing_mode: string } }>;
  next_cursor: string | null;
}

async function list(token: string, query = ""): Promise<Response> {
  return SELF.fetch(`${API}/v1/pages${query}`, authed(token));
}

async function listJson(token: string, query = ""): Promise<ListResponse> {
  const res = await list(token, query);
  if (res.status !== 200) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ListResponse;
}

describe("GET /v1/pages", () => {
  it("lists owned pages most recently updated first", async () => {
    const a = await createPage("lister-1");
    const b = await createPage("lister-1");
    const c = await createPage("lister-1");

    // Touch page `a` so it becomes the most recently updated.
    await SELF.fetch(`${API}/v1/pages/${a.uuid}`, {
      method: "PUT",
      ...authed("lister-1", { headers: { "Content-Type": "text/html" } }),
      body: "<p>updated</p>",
    });

    const body = await listJson("lister-1");
    const uuids = body.pages.map((p) => p.uuid);
    // `a` was updated last so it must sort first; b/c may share a timestamp,
    // so only assert membership for them.
    expect(uuids[0]).toBe(a.uuid);
    expect(new Set(uuids)).toEqual(new Set([a.uuid, b.uuid, c.uuid]));
    expect(body.next_cursor).toBeNull();
  });

  it("defaults to the owned collection", async () => {
    await createPage("lister-2");
    const owned = await listJson("lister-2");
    const explicit = await listJson("lister-2", "?collection=owned");
    expect(owned.pages.map((p) => p.uuid)).toEqual(
      explicit.pages.map((p) => p.uuid),
    );
    expect(owned.pages).toHaveLength(1);
  });

  it("does not include public pages from other users", async () => {
    const page = await createPage("lister-3");
    await setSharing("lister-3", page.uuid, { sharing_mode: "public" });

    const other = await listJson("other-user", "?collection=all");
    expect(other.pages).toEqual([]);
  });

  it("includes specific_users pages in shared_with_me for the listed email", async () => {
    const mine = await createPage("owner@example.com");
    const shared = await createPage("other-owner");
    await setSharing("other-owner", shared.uuid, {
      sharing_mode: "specific_users",
      emails: ["owner@example.com"],
    });

    const sharedList = await listJson(
      "owner@example.com",
      "?collection=shared_with_me",
    );
    expect(sharedList.pages.map((p) => p.uuid)).toEqual([shared.uuid]);

    const all = await listJson("owner@example.com", "?collection=all");
    expect(new Set(all.pages.map((p) => p.uuid))).toEqual(
      new Set([mine.uuid, shared.uuid]),
    );

    // A user with a different email sees nothing shared.
    const stranger = await listJson(
      "stranger@example.com",
      "?collection=shared_with_me",
    );
    expect(stranger.pages).toEqual([]);
  });

  it("paginates with an opaque cursor and stable ordering", async () => {
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await createPage("pager"));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const query: string = `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const body: ListResponse = await listJson("pager", query);
      expect(body.pages.length).toBeLessThanOrEqual(2);
      seen.push(...body.pages.map((p) => p.uuid));
      cursor = body.next_cursor;
      requests++;
    } while (cursor !== null && requests < 10);

    expect(requests).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(created.map((p) => p.uuid)));
  });

  it("rejects unknown collections and invalid limits and cursors", async () => {
    expect((await list("lister-4", "?collection=mine")).status).toBe(400);
    expect((await list("lister-4", "?limit=0")).status).toBe(400);
    expect((await list("lister-4", "?limit=abc")).status).toBe(400);
    expect((await list("lister-4", "?cursor=%%%")).status).toBe(400);
    expect((await list("lister-4", "?cursor=bm90LWpzb24")).status).toBe(400);
  });

  it("clamps the limit to 100", async () => {
    const res = await list("lister-5", "?limit=500");
    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch(`${API}/v1/pages`);
    expect(res.status).toBe(401);
  });
});
