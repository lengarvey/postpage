import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API, authed } from "./helpers";

const HTML = "<!doctype html><html><body>anon page</body></html>";
const PAGES = "https://pages.postpage.ai";
const DAY_MS = 24 * 60 * 60_000;

interface GuestPage {
  uuid: string;
  url: string;
  created_at: string;
  expires_at: string | null;
  sharing: { sharing_mode: string };
  guest_token: string;
}

async function publishAnonymously(ip = "192.0.2.50"): Promise<GuestPage> {
  const res = await SELF.fetch(`${API}/v1/pages`, {
    method: "POST",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "CF-Connecting-IP": ip,
    },
    body: HTML,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as GuestPage;
}

/** Extract the pp_viewer cookie pair from a response, or null. */
function viewerCookie(res: Response): string | null {
  const header = res.headers.get("Set-Cookie") ?? "";
  const match = /pp_viewer=[^;]+/.exec(header);
  return match?.[0] ?? null;
}

describe("anonymous publishing", () => {
  it("mints a guest account and returns the token exactly once", async () => {
    const page = await publishAnonymously();
    expect(page.guest_token).toMatch(/^pp_guest_/);
    expect(page.sharing).toEqual({ sharing_mode: "private" });
    // Fixed 1-week TTL from publish.
    expect(page.expires_at).toBe(
      new Date(Date.parse(page.created_at) + 7 * DAY_MS).toISOString(),
    );

    // The token never appears again on later reads.
    const read = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed(page.guest_token, { headers: { Accept: "application/json" } }),
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as Record<string, unknown>;
    expect(body.guest_token).toBeUndefined();
  });

  it("lets the guest token manage its pages like any owner", async () => {
    const page = await publishAnonymously();
    const token = page.guest_token;

    // list
    const list = await SELF.fetch(`${API}/v1/pages`, authed(token));
    expect(list.status).toBe(200);
    const { pages } = (await list.json()) as { pages: { uuid: string }[] };
    expect(pages.map((p) => p.uuid)).toContain(page.uuid);

    // update
    const put = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "PUT",
      ...authed(token, { headers: { "Content-Type": "text/html" } }),
      body: "<!doctype html><html><body>v2</body></html>",
    });
    expect(put.status).toBe(200);

    // pull
    const pull = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed(token, { headers: { Accept: "text/html" } }),
    );
    expect(await pull.text()).toContain("v2");

    // delete
    const del = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed(token),
    });
    expect(del.status).toBe(204);
  });

  it("forbids guests from changing sharing", async () => {
    const page = await publishAnonymously();
    const res = await SELF.fetch(`${API}/v1/pages/${page.uuid}/sharing`, {
      method: "PUT",
      ...authed(page.guest_token, {
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ sharing_mode: "public" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "forbidden",
    );
  });

  it("locks browser viewing to the first browser", async () => {
    const page = await publishAnonymously();
    const url = `${PAGES}/${page.uuid}`;

    // First browser: served, viewer cookie minted.
    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(HTML);
    const cookie = viewerCookie(first);
    expect(cookie).not.toBeNull();
    expect(first.headers.get("Set-Cookie")).toContain("HttpOnly");

    // Same browser again: served, no new cookie needed.
    const again = await SELF.fetch(url, { headers: { Cookie: cookie! } });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(HTML);

    // A different browser (no cookie): lockout page, no cookie minted.
    const other = await SELF.fetch(url);
    expect(other.status).toBe(403);
    expect(viewerCookie(other)).toBeNull();
    const lockout = await other.text();
    expect(lockout).toContain("locked to another browser");
    expect(lockout).toContain("Sign up");

    // A different browser with its own cookie from another page: lockout too.
    const foreign = await SELF.fetch(url, {
      headers: { Cookie: "pp_viewer=some-other-browser" },
    });
    expect(foreign.status).toBe(403);
  });

  it("one viewer cookie covers all of a browser's guest pages", async () => {
    const a = await publishAnonymously();
    const b = await publishAnonymously();

    const first = await SELF.fetch(`${PAGES}/${a.uuid}`);
    const cookie = viewerCookie(first)!;

    const second = await SELF.fetch(`${PAGES}/${b.uuid}`, {
      headers: { Cookie: cookie },
    });
    expect(second.status).toBe(200);
    // The existing cookie was reused, not replaced.
    expect(viewerCookie(second)).toBeNull();
  });

  it("bypasses the viewer lock for the owning guest token, and only it", async () => {
    const page = await publishAnonymously();
    const url = `${PAGES}/${page.uuid}`;

    // Bind the page to some other browser first.
    expect((await SELF.fetch(url)).status).toBe(200);

    // Guest token still reads it over HTTP on the serving origin.
    const owner = await SELF.fetch(url, authed(page.guest_token));
    expect(owner.status).toBe(200);
    expect(await owner.text()).toBe(HTML);

    // Any other bearer is a foreign API caller.
    expect((await SELF.fetch(url, authed("someone-else"))).status).toBe(403);
    // A present-but-invalid bearer keeps the API 401 contract.
    expect(
      (await SELF.fetch(url, { headers: { Authorization: "Bearer " } })).status,
    ).toBe(401);
  });
});
