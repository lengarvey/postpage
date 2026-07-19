import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  requireAuth,
  type AuthVariables,
} from "../src/middleware/auth";
import type { Env } from "../src/env";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.get("/whoami", requireAuth, (c) => c.json(c.get("identity")));

const devEnv = { AUTH_MODE: "dev-stub" } as Env;

describe("requireAuth (dev stub)", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await app.request("/whoami", {}, devEnv);
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
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: "Bearer " } },
      devEnv,
    );
    expect(res.status).toBe(401);
  });

  it("derives identity from an opaque token", async () => {
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: "Bearer user-1" } },
      devEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-1", email: null });
  });

  it("treats an email-shaped token as a verified email", async () => {
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: "Bearer Alex@Example.com" } },
      devEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "Alex@Example.com",
      email: "alex@example.com",
    });
  });
});

describe("requireAuth (WorkOS access tokens)", () => {
  async function workosTestEnv() {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    jwk.alg = "RS256";
    jwk.kid = "test-key";
    const testEnv = {
      DB: env.DB,
      WORKOS_API_KEY: "sk_test_fake",
      WORKOS_CLIENT_ID: "client_test_fake",
      WORKOS_JWKS: JSON.stringify({ keys: [jwk] }),
    } as Env;
    return { testEnv, privateKey };
  }

  function signToken(
    privateKey: CryptoKey,
    { sub, expiresIn }: { sub?: string; expiresIn: string },
  ) {
    let jwt = new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime(expiresIn);
    if (sub !== undefined) jwt = jwt.setSubject(sub);
    return jwt.sign(privateKey);
  }

  it("accepts a valid access token for a known user", async () => {
    const { testEnv, privateKey } = await workosTestEnv();
    await env.DB.prepare(
      `INSERT INTO users (workos_user_id, email, email_verified, created_at, updated_at)
       VALUES ('user_01TEST', 'alex@example.com', 1, '2026-01-01', '2026-01-01')`,
    ).run();

    const token = await signToken(privateKey, {
      sub: "user_01TEST",
      expiresIn: "5m",
    });
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user_01TEST",
      email: "alex@example.com",
    });
  });

  it("hides unverified emails from identity", async () => {
    const { testEnv, privateKey } = await workosTestEnv();
    await env.DB.prepare(
      `INSERT INTO users (workos_user_id, email, email_verified, created_at, updated_at)
       VALUES ('user_02TEST', 'sam@example.com', 0, '2026-01-01', '2026-01-01')`,
    ).run();

    const token = await signToken(privateKey, {
      sub: "user_02TEST",
      expiresIn: "5m",
    });
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user_02TEST", email: null });
  });

  it("rejects expired tokens", async () => {
    const { testEnv, privateKey } = await workosTestEnv();
    const token = await signToken(privateKey, {
      sub: "user_01TEST",
      expiresIn: "-5m",
    });
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("rejects tokens without a subject", async () => {
    const { testEnv, privateKey } = await workosTestEnv();
    const token = await signToken(privateKey, { expiresIn: "5m" });
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("rejects garbage tokens signed by nobody", async () => {
    const { testEnv } = await workosTestEnv();
    const res = await app.request(
      "/whoami",
      { headers: { Authorization: "Bearer not-a-jwt" } },
      testEnv,
    );
    expect(res.status).toBe(401);
  });
});
