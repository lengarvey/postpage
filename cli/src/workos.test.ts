import { describe, expect, it } from "vitest";
import { jwtExpiry } from "./workos.js";

function fakeJwt(payload: object): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

describe("jwtExpiry", () => {
  it("extracts the exp claim", () => {
    expect(jwtExpiry(fakeJwt({ exp: 1234567890 }))).toBe(1234567890);
  });

  it("returns null without an exp claim", () => {
    expect(jwtExpiry(fakeJwt({ sub: "user_1" }))).toBeNull();
  });

  it("returns null for non-JWT tokens", () => {
    expect(jwtExpiry("user-1")).toBeNull();
    expect(jwtExpiry("")).toBeNull();
  });
});
