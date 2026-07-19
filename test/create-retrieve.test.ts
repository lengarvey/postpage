import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API, authed, createPage } from "./helpers";

const HTML = "<!doctype html><html><body><h1>Report</h1></body></html>";

describe("POST /v1/pages", () => {
  it("creates a private page from raw HTML and returns 201 metadata", async () => {
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      ...authed("user-1", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
      body: HTML,
    });
    expect(res.status).toBe(201);
    const page = (await res.json()) as Record<string, unknown>;

    expect(page.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.url).toBe(`https://pages.postpage.ai/${page.uuid}`);
    expect(page.current_revision).toBe(1);
    expect(page.sharing).toEqual({ sharing_mode: "private" });

    // Stored byte-for-byte in R2 under the revision key.
    const object = await env.PAGES_BUCKET.get(`pages/${page.uuid}/00000001.html`);
    expect(await object?.text()).toBe(HTML);
  });

  it("requires authentication", async () => {
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: HTML,
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-HTML content types", async () => {
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      ...authed("user-1", {
        headers: { "Content-Type": "application/json" },
      }),
      body: "{}",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unsupported_media_type");
  });

  it("rejects empty bodies", async () => {
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      ...authed("user-1", { headers: { "Content-Type": "text/html" } }),
      body: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("empty_body");
  });

  it("rejects bodies over 10 MiB with problem+json", async () => {
    const big = "x".repeat(10_485_761);
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      ...authed("user-1", { headers: { "Content-Type": "text/html" } }),
      body: big,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("page_too_large");
    expect(body.detail).toContain("10485760");
    expect(res.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
  });

  it("accepts a body of exactly 10 MiB", async () => {
    const exact = "x".repeat(10_485_760);
    const res = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      ...authed("user-1", { headers: { "Content-Type": "text/html" } }),
      body: exact,
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /v1/pages/{uuid}", () => {
  it("returns raw HTML by default", async () => {
    const page = await createPage("user-1", HTML);
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe(HTML);
  });

  it("treats Accept: */* as text/html", async () => {
    const page = await createPage("user-1", HTML);
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1", { headers: { Accept: "*/*" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns metadata plus HTML for Accept: application/json", async () => {
    const page = await createPage("user-1", HTML);
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1", { headers: { Accept: "application/json" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uuid).toBe(page.uuid);
    expect(body.url).toBe(page.url);
    expect(body.html).toBe(HTML);
    expect(body.current_revision).toBe(1);
    expect(body.sharing).toEqual({ sharing_mode: "private" });
  });

  it("returns 406 for unsupported Accept types", async () => {
    const page = await createPage("user-1");
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-1", { headers: { Accept: "application/xml" } }),
    );
    expect(res.status).toBe(406);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_acceptable");
  });

  it("returns 404 for an unknown uuid", async () => {
    const res = await SELF.fetch(
      `${API}/v1/pages/${crypto.randomUUID()}`,
      authed("user-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed uuid", async () => {
    const res = await SELF.fetch(
      `${API}/v1/pages/not-a-uuid`,
      authed("user-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for an authenticated non-owner on a private page", async () => {
    const page = await createPage("user-1");
    const res = await SELF.fetch(
      `${API}/v1/pages/${page.uuid}`,
      authed("user-2"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
  });
});
