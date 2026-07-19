import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPage } from "./helpers";

const HTML = "<!doctype html><html><body>secret</body></html>";
const APEX = "https://pages.postpage.ai";

function pageUrl(page: { hostname: string; uuid: string }): string {
  return `https://${page.hostname}.pages.postpage.ai/s/${page.uuid}`;
}

async function seedLoginCode(fields: {
  code: string;
  host: string;
  path: string;
  userId?: string;
  email?: string | null;
  expiresAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_codes (code, workos_user_id, email, host, redirect_path, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      fields.code,
      fields.userId ?? "user_01TEST",
      fields.email ?? "alex@example.com",
      fields.host,
      fields.path,
      fields.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
}

describe("browser login redirect", () => {
  it("sends unauthenticated browsers through the apex login", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(pageUrl(page), { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe(APEX);
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

describe("/auth/login (apex)", () => {
  it("redirects to the WorkOS authorization endpoint with signed state", async () => {
    const page = await createPage("owner-1", HTML);
    const res = await SELF.fetch(
      `${APEX}/auth/login?redirect=${encodeURIComponent(pageUrl(page))}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.hostname).toBe("api.workos.com");
    expect(location.searchParams.get("client_id")).toBe("client_test_fake");
    expect(location.searchParams.get("provider")).toBe("authkit");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${APEX}/auth/callback`,
    );
    expect(location.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("rejects destinations that are not canonical page URLs", async () => {
    const page = await createPage("owner-1", HTML);
    for (const bad of [
      "",
      "https://evil.example.com/s/" + page.uuid,
      // Right domain, wrong path shape.
      `https://${page.hostname}.pages.postpage.ai/`,
      `https://${page.hostname}.pages.postpage.ai/s/${page.uuid}/extra`,
      `https://${page.hostname}.pages.postpage.ai/s/not-a-uuid`,
      // Apex itself is not a page host.
      `https://pages.postpage.ai/s/${page.uuid}`,
      // Nested subdomain smuggling.
      `https://a.b.pages.postpage.ai/s/${page.uuid}`,
    ]) {
      const res = await SELF.fetch(
        `${APEX}/auth/login?redirect=${encodeURIComponent(bad)}`,
        { redirect: "manual" },
      );
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("/auth/callback (apex)", () => {
  it("rejects a missing or tampered state", async () => {
    for (const state of ["", "garbage", "abc.def"]) {
      const res = await SELF.fetch(
        `${APEX}/auth/callback?code=x&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(res.status, state || "(empty)").toBe(400);
    }
  });
});

describe("/auth/session (page host)", () => {
  it("redeems a one-time code, sets a host-only cookie, and grants access", async () => {
    const page = await createPage("alex@example.com", HTML);
    const host = `${page.hostname}.pages.postpage.ai`;
    const path = `/s/${page.uuid}`;
    await seedLoginCode({
      code: "code-1",
      host,
      path,
      userId: "alex@example.com",
    });

    const res = await SELF.fetch(`https://${host}/auth/session?code=code-1`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(path);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("pp_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    // Host-only: no Domain attribute, so the cookie never crosses subdomains.
    expect(cookie).not.toContain("Domain=");

    const sessionCookie = cookie.split(";")[0]!;
    const view = await SELF.fetch(`https://${host}${path}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(view.status).toBe(200);
    expect(await view.text()).toBe(HTML);

    // The session is bound to this exact host: another page rejects it.
    const other = await createPage("someone-else", HTML);
    const crossed = await SELF.fetch(
      `https://${other.hostname}.pages.postpage.ai/s/${other.uuid}`,
      { headers: { Cookie: sessionCookie }, redirect: "manual" },
    );
    expect(crossed.status).toBe(302); // back to login, not served
  });

  it("grants specific_users access by the session's verified email", async () => {
    const page = await createPage("owner-1", HTML);
    const { setSharing } = await import("./helpers");
    await setSharing("owner-1", page.uuid, {
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
    const host = `${page.hostname}.pages.postpage.ai`;
    const path = `/s/${page.uuid}`;
    await seedLoginCode({
      code: "code-email",
      host,
      path,
      userId: "user_01TEST",
      email: "alex@example.com",
    });
    const res = await SELF.fetch(
      `https://${host}/auth/session?code=code-email`,
      { redirect: "manual" },
    );
    const sessionCookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    const view = await SELF.fetch(`https://${host}${path}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(view.status).toBe(200);
  });

  it("returns 403 for an authenticated but unauthorized session", async () => {
    const page = await createPage("owner-1", HTML);
    const host = `${page.hostname}.pages.postpage.ai`;
    const path = `/s/${page.uuid}`;
    await seedLoginCode({
      code: "code-stranger",
      host,
      path,
      userId: "user_stranger",
      email: "stranger@example.com",
    });
    const res = await SELF.fetch(
      `https://${host}/auth/session?code=code-stranger`,
      { redirect: "manual" },
    );
    const sessionCookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    const view = await SELF.fetch(`https://${host}${path}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(view.status).toBe(403);
  });

  it("rejects reuse, unknown codes, wrong hosts, and expired codes", async () => {
    const page = await createPage("owner-1", HTML);
    const host = `${page.hostname}.pages.postpage.ai`;
    const path = `/s/${page.uuid}`;

    await seedLoginCode({ code: "code-once", host, path });
    const first = await SELF.fetch(
      `https://${host}/auth/session?code=code-once`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    const reuse = await SELF.fetch(
      `https://${host}/auth/session?code=code-once`,
      { redirect: "manual" },
    );
    expect(reuse.status).toBe(401);

    expect(
      (
        await SELF.fetch(`https://${host}/auth/session?code=nope`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(`https://${host}/auth/session`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(401);

    // Minted for a different host: unusable here.
    await seedLoginCode({
      code: "code-wrong-host",
      host: "other-host-x1.pages.postpage.ai",
      path,
    });
    expect(
      (
        await SELF.fetch(`https://${host}/auth/session?code=code-wrong-host`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(401);

    await seedLoginCode({
      code: "code-expired",
      host,
      path,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(
      (
        await SELF.fetch(`https://${host}/auth/session?code=code-expired`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(401);
  });

  it("ignores expired sessions", async () => {
    const page = await createPage("owner-1", HTML);
    const host = `${page.hostname}.pages.postpage.ai`;
    await env.DB.prepare(
      `INSERT INTO page_sessions (id, host, workos_user_id, email, created_at, expires_at)
       VALUES ('sess-old', ?, 'owner-1', NULL, '2026-01-01', ?)`,
    )
      .bind(host, new Date(Date.now() - 1000).toISOString())
      .run();
    const res = await SELF.fetch(`https://${host}/s/${page.uuid}`, {
      headers: { Cookie: "pp_session=sess-old" },
      redirect: "manual",
    });
    expect(res.status).toBe(302); // treated as unauthenticated
  });
});
