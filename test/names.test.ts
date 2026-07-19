import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  HOSTNAME_PATTERN,
  candidateHostname,
  generateUniqueHostname,
} from "../src/lib/names";

describe("candidateHostname", () => {
  it("always matches the adjective-noun-suffix shape", () => {
    for (let i = 0; i < 500; i++) {
      expect(candidateHostname()).toMatch(HOSTNAME_PATTERN);
    }
  });

  it("is deterministic for a fixed rng", () => {
    const zero = candidateHostname(() => 0);
    expect(zero).toBe(candidateHostname(() => 0));
    expect(zero).toMatch(HOSTNAME_PATTERN);
  });
});

describe("generateUniqueHostname", () => {
  it("skips hostnames taken by live pages", async () => {
    const taken = candidateHostname(() => 0);
    await env.DB.prepare(
      `INSERT INTO pages (uuid, hostname, owner_id, current_revision, next_revision, sharing_mode, created_at, updated_at)
       VALUES (?, ?, 'user-1', 1, 2, 'private', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
      .bind(crypto.randomUUID(), taken)
      .run();

    // rng yields 0 (collision with `taken`) then 0.5s (a different name).
    let calls = 0;
    const rng = () => (calls++ < 4 ? 0 : 0.5);
    const hostname = await generateUniqueHostname(env.DB, { rng });
    expect(hostname).not.toBe(taken);
    expect(hostname).toMatch(HOSTNAME_PATTERN);
  });

  it("never reuses a tombstoned hostname", async () => {
    const dead = candidateHostname(() => 0.25);
    await env.DB.prepare(
      `INSERT INTO tombstones (uuid, hostname, owner_id, deleted_at)
       VALUES (?, ?, 'user-1', '2026-01-01T00:00:00Z')`,
    )
      .bind(crypto.randomUUID(), dead)
      .run();

    let calls = 0;
    const rng = () => (calls++ < 4 ? 0.25 : 0.75);
    const hostname = await generateUniqueHostname(env.DB, { rng });
    expect(hostname).not.toBe(dead);
  });

  it("gives up after maxAttempts collisions", async () => {
    const stuck = candidateHostname(() => 0.1);
    await env.DB.prepare(
      `INSERT INTO tombstones (uuid, hostname, owner_id, deleted_at)
       VALUES (?, ?, 'user-1', '2026-01-01T00:00:00Z')`,
    )
      .bind(crypto.randomUUID(), stuck)
      .run();

    await expect(
      generateUniqueHostname(env.DB, { rng: () => 0.1, maxAttempts: 3 }),
    ).rejects.toThrow(/unique hostname/);
  });
});
