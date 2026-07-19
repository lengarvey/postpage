import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("responds to the health check", async () => {
    const res = await SELF.fetch("http://api.local/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("has the D1 schema applied", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pages",
        "revisions",
        "page_permissions",
        "tombstones",
      ]),
    );
  });

  it("serves the landing page at the main origin root", async () => {
    const res = await SELF.fetch("http://api.local/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Postpage");
    expect(html).toContain("<!doctype html>");
  });

  it("does not serve the landing page on the serving origin", async () => {
    expect((await SELF.fetch("https://pages.postpage.ai/")).status).toBe(404);
  });

  it("returns problem+json for unknown API paths", async () => {
    const res = await SELF.fetch("http://api.local/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("has a writable R2 bucket binding", async () => {
    await env.PAGES_BUCKET.put("smoke-test", "hello");
    const obj = await env.PAGES_BUCKET.get("smoke-test");
    expect(await obj?.text()).toBe("hello");
  });
});
