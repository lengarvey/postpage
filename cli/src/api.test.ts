import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";
import { readCredentials, writeCredentials } from "./config.js";
import { CliError } from "./errors.js";

const API_URL = "https://api.example.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient anonymous requests", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "postpage-api-"));
    process.env["POSTPAGE_CONFIG_DIR"] = dir;
    delete process.env["POSTPAGE_TOKEN"];
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["POSTPAGE_CONFIG_DIR"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits Authorization on an anonymous request with no credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ uuid: "u" }, 201));
    const client = new ApiClient(API_URL);
    expect(client.hasAuth()).toBe(false);
    await client.requestJson("POST", "/v1/pages", { anonymous: true, body: "<h1></h1>" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("still sends the bearer token on an anonymous request when logged in", async () => {
    writeCredentials({ api_url: API_URL, auth: { kind: "token", token: "tok-1" } });
    fetchMock.mockResolvedValue(jsonResponse({ uuid: "u" }, 201));
    const client = new ApiClient(API_URL);
    await client.requestJson("POST", "/v1/pages", { anonymous: true, body: "<h1></h1>" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("fails locally on a non-anonymous request with no credentials", async () => {
    const client = new ApiClient(API_URL);
    await expect(client.request("GET", "/v1/pages")).rejects.toThrow(CliError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a guest token as stored token credentials", () => {
    const client = new ApiClient(API_URL);
    client.saveGuestToken("pp_guest_abc");
    expect(readCredentials()).toEqual({
      api_url: API_URL,
      auth: { kind: "token", token: "pp_guest_abc" },
    });
    expect(client.hasAuth()).toBe(true);
  });
});
