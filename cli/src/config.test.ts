import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./config.js";

describe("credential storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "postpage-config-"));
    process.env["POSTPAGE_CONFIG_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["POSTPAGE_CONFIG_DIR"];
    rmSync(dir, { recursive: true, force: true });
  });

  const credentials: Credentials = {
    api_url: "https://api.postpage.ai",
    auth: { kind: "token", token: "user-1" },
  };

  it("round-trips credentials", () => {
    expect(readCredentials()).toBeNull();
    writeCredentials(credentials);
    expect(readCredentials()).toEqual(credentials);
  });

  it("writes the file owner-readable only", () => {
    writeCredentials(credentials);
    const mode = statSync(join(dir, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("deletes credentials and reports whether any existed", () => {
    expect(deleteCredentials()).toBe(false);
    writeCredentials(credentials);
    expect(deleteCredentials()).toBe(true);
    expect(readCredentials()).toBeNull();
  });
});
