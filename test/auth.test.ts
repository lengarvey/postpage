import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  requireAuth,
  type AuthVariables,
} from "../src/middleware/auth";
import type { Env } from "../src/env";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.get("/whoami", requireAuth, (c) => c.json(c.get("identity")));

describe("requireAuth (dev stub)", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await app.request("/whoami");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unauthorized");
    expect(body.type).toBe("https://postpage.ai/problems/unauthorized");
    expect(body.status).toBe(401);
  });

  it("rejects an empty bearer token", async () => {
    const res = await app.request("/whoami", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("derives identity from an opaque token", async () => {
    const res = await app.request("/whoami", {
      headers: { Authorization: "Bearer user-1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-1", email: null });
  });

  it("treats an email-shaped token as a verified email", async () => {
    const res = await app.request("/whoami", {
      headers: { Authorization: "Bearer Alex@Example.com" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "Alex@Example.com",
      email: "alex@example.com",
    });
  });
});
