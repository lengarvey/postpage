import { env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { establishSession } from "../src/routes/auth";
import { createPage, setSharing } from "./helpers";

const HTML = "<!doctype html><html><body>secret</body></html>";
const ORIGIN = "https://pages.postpage.ai";

function pageUrl(page: { uuid: string }): string {
  return `${ORIGIN}/${page.uuid}`;
}

async function seedSession(fields: {
  id: string;
  userId: string;
  email?: string | null;
  expiresAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO page_sessions (id, workos_user_id, email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      fields.id,
      fields.userId,
      fields.email ?? null,
      new Date().toISOString(),
      fields.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
}

describe("browser login redirect", () => {
  it("sends unauthenticated browsers through /auth/login on the same origin", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(pageUrl(page), { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("redirect")).toBe(pageUrl(page));
  });

  it("keeps the 401 contract for invalid bearer tokens", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(pageUrl(page), {
      headers: { Authorization: "Bearer" },
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });
});

describe("/auth/login", () => {
  it("redirects to the WorkOS authorization endpoint with signed state", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(
      `${ORIGIN}/auth/login?redirect=${encodeURIComponent(pageUrl(page))}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.hostname).toBe("api.workos.com");
    expect(location.searchParams.get("client_id")).toBe("client_test_fake");
    expect(location.searchParams.get("provider")).toBe("authkit");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/callback`,
    );
    expect(location.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("rejects destinations that are not canonical page URLs", async () => {
    const page = await createPage("owner-1", HTML);
    for (const bad of [
      "",
      `https://evil.example.com/${page.uuid}`,
      // Right origin, wrong path shape.
      `${ORIGIN}/`,
      `${ORIGIN}/${page.uuid}/extra`,
      `${ORIGIN}/not-a-uuid`,
      `${ORIGIN}/auth/login`,
      // Old per-subdomain URL forms.
      `${ORIGIN}/s/${page.uuid}`,
      `https://amber-otter-k7.pages.postpage.ai/${page.uuid}`,
      // The API origin never serves pages.
      `https://api.postpage.ai/${page.uuid}`,
    ]) {
      const res = await SELF.fetch(
        `${ORIGIN}/auth/login?redirect=${encodeURIComponent(bad)}`,
        { redirect: "manual" },
      );
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("/auth/callback", () => {
  it("rejects a missing or tampered state", async () => {
    for (const state of ["", "garbage", "abc.def"]) {
      const res = await SELF.fetch(
        `${ORIGIN}/auth/callback?code=x&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(res.status, state || "(empty)").toBe(400);
    }
  });
});

describe("browser sessions", () => {
  it("establishSession sets a host-only HTTP-only cookie backed by D1", async () => {
    // The full callback exchanges a code with WorkOS over the network; the
    // session-establishing half it ends with is exercised directly.
    const app = new Hono<{ Bindings: Env }>();
    app.get("/test-establish", async (c) => {
      await establishSession(c, {
        userId: "user_01TEST",
        email: "alex@example.com",
      });
      return c.text("ok");
    });
    const res = await app.request(`${ORIGIN}/test-establish`, {}, env);
    expect(res.status).toBe(200);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("pp_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    // Host-only: no Domain attribute, so the cookie stays on this origin.
    expect(cookie).not.toContain("Domain=");

    const sessionId = /pp_session=([^;]+)/.exec(cookie)?.[1];
    const row = await env.DB.prepare(
      "SELECT workos_user_id, email FROM page_sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ workos_user_id: string; email: string | null }>();
    expect(row?.workos_user_id).toBe("user_01TEST");
    expect(row?.email).toBe("alex@example.com");
  });

  it("one session grants access to every page the user may view", async () => {
    const one = await createPage("alex@example.com", HTML);
    const two = await createPage("alex@example.com", HTML);
    await seedSession({ id: "sess-owner", userId: "alex@example.com" });

    for (const page of [one, two]) {
      const res = await SELF.fetch(pageUrl(page), {
        headers: { Cookie: "pp_session=sess-owner" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(HTML);
    }
  });

  it("grants specific_users access by the session's verified email", async () => {
    const page = await createPage("owner-1", HTML);
    await setSharing("owner-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
    await seedSession({
      id: "sess-email",
      userId: "user_01TEST",
      email: "alex@example.com",
    });
    const res = await SELF.fetch(pageUrl(page), {
      headers: { Cookie: "pp_session=sess-email" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 for an authenticated but unauthorized session", async () => {
    const page = await createPage("owner-1", HTML);
    await seedSession({
      id: "sess-stranger",
      userId: "user_stranger",
      email: "stranger@example.com",
    });
    const res = await SELF.fetch(pageUrl(page), {
      headers: { Cookie: "pp_session=sess-stranger" },
    });
    expect(res.status).toBe(403);
  });

  it("ignores unknown and expired sessions", async () => {
    const page = await createPage("owner-1", HTML);

    const unknown = await SELF.fetch(pageUrl(page), {
      headers: { Cookie: "pp_session=never-created" },
      redirect: "manual",
    });
    expect(unknown.status).toBe(302); // treated as unauthenticated

    await seedSession({
      id: "sess-old",
      userId: "owner-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const expired = await SELF.fetch(pageUrl(page), {
      headers: { Cookie: "pp_session=sess-old" },
      redirect: "manual",
    });
    expect(expired.status).toBe(302);

    // Expired sessions are removed on sight.
    const row = await env.DB.prepare(
      "SELECT id FROM page_sessions WHERE id = 'sess-old'",
    ).first();
    expect(row).toBeNull();
  });
});
