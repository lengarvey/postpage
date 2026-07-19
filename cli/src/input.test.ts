import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { readBody, resolveBodySource } from "./input.js";

describe("resolveBodySource", () => {
  it("uses the file when stdin is a TTY", () => {
    expect(resolveBodySource("page.html", true)).toEqual({
      source: "file",
      file: "page.html",
    });
  });

  it("uses stdin when piped and no file is given", () => {
    expect(resolveBodySource(undefined, false)).toEqual({ source: "stdin" });
  });

  it("rejects a file argument combined with piped stdin", () => {
    expect(() => resolveBodySource("page.html", false)).toThrowError(CliError);
  });

  it("rejects neither source (usage)", () => {
    try {
      resolveBodySource(undefined, true);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});

describe("readBody", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("reads file contents", () => {
    dir = mkdtempSync(join(tmpdir(), "postpage-cli-"));
    const file = join(dir, "page.html");
    writeFileSync(file, "<h1>hi</h1>");
    expect(new TextDecoder().decode(readBody({ source: "file", file }))).toBe(
      "<h1>hi</h1>",
    );
  });

  it("rejects an empty file", () => {
    dir = mkdtempSync(join(tmpdir(), "postpage-cli-"));
    const file = join(dir, "empty.html");
    writeFileSync(file, "");
    expect(() => readBody({ source: "file", file })).toThrowError(/empty/);
  });
});
