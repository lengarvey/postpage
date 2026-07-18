import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API, authed, createPage, setSharing } from "./helpers";

const HTML = "<!doctype html><html><body><h1>Doc</h1><script>1</script></body></html>";

function pageUrl(page: { hostname: string; uuid: string }): string {
  return `https://${page.hostname}.pages.postpage.ai/s/${page.uuid}`;
}

describe("hosted page serving", () => {
  it("serves a public page byte-for-byte without login", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });

    const res = await SELF.fetch(pageUrl(page));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("applies the isolation security headers", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });

    const res = await SELF.fetch(pageUrl(page));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    // Public pages may be embedded by other sites.
    expect(csp).not.toContain("frame-ancestors");

    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe(
      "noindex, noarchive, nosnippet",
    );
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("blocks embedding of non-public pages", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(pageUrl(page), authed("owner-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("enforces sharing on every request", async () => {
    const page = await createPage("owner-1", HTML);

    // Private: no session -> 401 (login redirect placeholder), stranger -> 403.
    expect((await SELF.fetch(pageUrl(page))).status).toBe(401);
    expect((await SELF.fetch(pageUrl(page), authed("stranger"))).status).toBe(
      403,
    );
    expect((await SELF.fetch(pageUrl(page), authed("owner-1"))).status).toBe(
      200,
    );

    // specific_users: listed verified email may view.
    await setSharing("owner-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
    expect(
      (await SELF.fetch(pageUrl(page), authed("alex@example.com"))).status,
    ).toBe(200);
    expect(
      (await SELF.fetch(pageUrl(page), authed("sam@example.com"))).status,
    ).toBe(403);

    // Back to public: served without login on the next request.
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });
    expect((await SELF.fetch(pageUrl(page))).status).toBe(200);
  });

  it("serves updated content after a new revision", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });
    expect(await (await SELF.fetch(pageUrl(page))).text()).toBe(HTML);

    const v2 = "<!doctype html><html><body>v2</body></html>";
    await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "PUT",
      ...authed("owner-1", { headers: { "Content-Type": "text/html" } }),
      body: v2,
    });
    expect(await (await SELF.fetch(pageUrl(page))).text()).toBe(v2);
  });

  it("returns 404 for anything but the exact /s/{uuid} path", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });
    const origin = `https://${page.hostname}.pages.postpage.ai`;

    for (const path of [
      "/",
      "/index.html",
      `/s/${page.uuid}/extra`,
      "/s/not-a-uuid",
      `/s/${crypto.randomUUID()}`, // valid uuid, wrong hostname
      "/r/whatever",
    ]) {
      const res = await SELF.fetch(`${origin}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("returns 404 for an unknown hostname", async () => {
    const res = await SELF.fetch(
      `https://never-created-z9.pages.postpage.ai/s/${crypto.randomUUID()}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 after deletion", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });
    await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("owner-1"),
    });
    expect((await SELF.fetch(pageUrl(page))).status).toBe(404);
  });
});

describe("resolver", () => {
  it("redirects to the canonical page URL", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(
      `https://pages.postpage.ai/r/${page.uuid}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(pageUrl(page));
  });

  it("also works on the API origin for local development", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(`${API}/r/${page.uuid}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(pageUrl(page));
  });

  it("never serves page content from the apex origin", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, { sharing_mode: "public" });
    for (const path of ["/", `/s/${page.uuid}`, "/v1/pages"]) {
      const res = await SELF.fetch(`https://pages.postpage.ai${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("returns 404 for unknown or invalid uuids and deleted pages", async () => {
    expect(
      (await SELF.fetch(`https://pages.postpage.ai/r/${crypto.randomUUID()}`))
        .status,
    ).toBe(404);
    expect(
      (await SELF.fetch("https://pages.postpage.ai/r/nope")).status,
    ).toBe(404);

    const page = await createPage("owner-1", HTML);
    await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
      method: "DELETE",
      ...authed("owner-1"),
    });
    expect(
      (
        await SELF.fetch(`https://pages.postpage.ai/r/${page.uuid}`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
  });
});
