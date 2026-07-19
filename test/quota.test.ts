import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { API, authed, createPage } from "./helpers";

const HTML = "<!doctype html><html><body>quota</body></html>";

function post(headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${API}/v1/pages`, {
    method: "POST",
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
    body: HTML,
  });
}

const anonymousPost = (ip: string): Promise<Response> =>
  post({ "CF-Connecting-IP": ip });

describe("publish quotas", () => {
  it("caps signed-in users at 30 pages per UTC day with 429 quota_exceeded", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await post({ Authorization: "Bearer quota-user" })).status).toBe(201);
    }
    const res = await post({ Authorization: "Bearer quota-user" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("quota_exceeded");

    // Another user's counter is independent.
    expect((await post({ Authorization: "Bearer other-user" })).status).toBe(201);
  });

  it("caps anonymous publishing at 5 pages per client IP per day", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await anonymousPost("192.0.2.1")).status).toBe(201);
    }
    const res = await anonymousPost("192.0.2.1");
    expect(res.status).toBe(429);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "quota_exceeded",
    );

    // A different client IP has its own counter.
    expect((await anonymousPost("192.0.2.2")).status).toBe(201);
  });

  it("never refunds quota on delete", async () => {
    const tokens: string[] = [];
    let firstUuid = "";
    for (let i = 0; i < 5; i++) {
      const res = await anonymousPost("198.51.100.7");
      expect(res.status).toBe(201);
      const body = (await res.json()) as { uuid: string; guest_token: string };
      tokens.push(body.guest_token);
      if (i === 0) firstUuid = body.uuid;
    }

    const del = await SELF.fetch(`${API}/v1/pages/${firstUuid}`, {
      method: "DELETE",
      ...authed(tokens[0]!),
    });
    expect(del.status).toBe(204);

    // The deleted page's slot is not returned.
    expect((await anonymousPost("198.51.100.7")).status).toBe(429);
  });

  it("counts guest-token creations against the client IP, not a user quota", async () => {
    const minted = await anonymousPost("203.0.113.9");
    const { guest_token } = (await minted.json()) as { guest_token: string };

    for (let i = 0; i < 4; i++) {
      const res = await post({
        Authorization: `Bearer ${guest_token}`,
        "CF-Connecting-IP": "203.0.113.9",
      });
      expect(res.status).toBe(201);
    }
    const res = await post({
      Authorization: `Bearer ${guest_token}`,
      "CF-Connecting-IP": "203.0.113.9",
    });
    expect(res.status).toBe(429);
  });

  it("refunds quota and deletes the guest row when createPage fails after they're claimed", async () => {
    const ip = "198.51.100.42";

    // Sanity: 4 successful posts leave exactly one slot before the forced
    // failure, so the counter's pre-failure state is known precisely.
    for (let i = 0; i < 4; i++) {
      expect((await anonymousPost(ip)).status).toBe(201);
    }

    const putSpy = vi
      .spyOn(env.PAGES_BUCKET, "put")
      .mockImplementation(() => {
        throw new Error("simulated R2 outage");
      });

    let guestCountBefore = 0;
    {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM guests",
      ).first<{ n: number }>();
      guestCountBefore = row!.n;
    }

    let failed: Response;
    try {
      failed = await anonymousPost(ip);
    } finally {
      putSpy.mockRestore();
    }
    expect(failed.status).toBe(500);

    // No orphan guest row was left behind by the failed attempt.
    const guestCountAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM guests",
    ).first<{ n: number }>();
    expect(guestCountAfter!.n).toBe(guestCountBefore);

    // The quota slot consumed by the failed attempt was refunded: the 5th
    // (last allowed) request for this IP still succeeds...
    expect((await anonymousPost(ip)).status).toBe(201);
    // ...and the 6th is over the daily limit.
    const overLimit = await anonymousPost(ip);
    expect(overLimit.status).toBe(429);
  });

  it("leaves updates (PUT) unlimited", async () => {
    const page = await createPage("put-user", HTML);
    // Well past any per-day create limit; every PUT must succeed.
    for (let i = 0; i < 3; i++) {
      const res = await SELF.fetch(`${API}/v1/pages/${page.uuid}`, {
        method: "PUT",
        ...authed("put-user", { headers: { "Content-Type": "text/html" } }),
        body: `${HTML}<!-- rev ${i} -->`,
      });
      expect(res.status).toBe(200);
    }
  });
});
