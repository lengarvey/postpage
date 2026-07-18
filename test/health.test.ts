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

  it("has a writable R2 bucket binding", async () => {
    await env.PAGES_BUCKET.put("smoke-test", "hello");
    const obj = await env.PAGES_BUCKET.get("smoke-test");
    expect(await obj?.text()).toBe("hello");
  });
});
