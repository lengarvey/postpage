import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { canonicalPageUrl, pageUrls, type PageRow } from "../src/lib/pages";

const page = {
  uuid: "2e530e38-d271-41c9-baa6-0ba9ea0a38ab",
  hostname: "humble-pine-wt",
} as PageRow;

function envWith(overrides: Partial<Env>): Env {
  return { PAGES_DOMAIN: "pages.postpage.ai", ...overrides } as Env;
}

describe("page URL rendering", () => {
  it("defaults to https on the pages domain", () => {
    const env = envWith({});
    expect(pageUrls(env, page)).toEqual({
      url: `https://humble-pine-wt.pages.postpage.ai/s/${page.uuid}`,
      resolver_url: `https://pages.postpage.ai/r/${page.uuid}`,
    });
  });

  it("respects PAGES_URL_BASE for local development", () => {
    const env = envWith({
      PAGES_DOMAIN: "pages.localhost",
      PAGES_URL_BASE: "http://pages.localhost:8787",
    });
    expect(pageUrls(env, page)).toEqual({
      url: `http://humble-pine-wt.pages.localhost:8787/s/${page.uuid}`,
      resolver_url: `http://pages.localhost:8787/r/${page.uuid}`,
    });
    expect(canonicalPageUrl(env, page.hostname, page.uuid)).toBe(
      `http://humble-pine-wt.pages.localhost:8787/s/${page.uuid}`,
    );
  });
});
