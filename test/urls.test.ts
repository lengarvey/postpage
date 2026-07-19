import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { canonicalPageUrl } from "../src/lib/pages";

const uuid = "2e530e38-d271-41c9-baa6-0ba9ea0a38ab";

function envWith(overrides: Partial<Env>): Env {
  return { PAGES_DOMAIN: "pages.postpage.ai", ...overrides } as Env;
}

describe("page URL rendering", () => {
  it("defaults to https on the pages domain", () => {
    expect(canonicalPageUrl(envWith({}), uuid)).toBe(
      `https://pages.postpage.ai/${uuid}`,
    );
  });

  it("respects PAGES_URL_BASE for local development", () => {
    const env = envWith({
      PAGES_DOMAIN: "pages.localhost",
      PAGES_URL_BASE: "http://pages.localhost:8787",
    });
    expect(canonicalPageUrl(env, uuid)).toBe(
      `http://pages.localhost:8787/${uuid}`,
    );
  });
});
