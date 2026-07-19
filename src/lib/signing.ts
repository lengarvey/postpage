/**
 * HMAC-signed, expiring payloads for the OAuth `state` parameter. The payload
 * round-trips through WorkOS untouched; the signature proves it originated
 * from our /auth/login and the embedded timestamp bounds its lifetime.
 */

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a payload (with an issued-at timestamp) into an opaque state string. */
export async function signState(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const body = encoder.encode(JSON.stringify({ ...payload, iat: Date.now() }));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), body);
  return `${base64UrlEncode(body)}.${base64UrlEncode(new Uint8Array(mac))}`;
}

/**
 * Verify a state string's signature and age; returns the payload or null.
 */
export async function verifyState<T extends { iat: number }>(
  secret: string,
  state: string,
  maxAgeMs: number,
): Promise<T | null> {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = base64UrlDecode(state.slice(0, dot));
  const mac = base64UrlDecode(state.slice(dot + 1));
  if (body === null || mac === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    mac as unknown as ArrayBuffer,
    body as unknown as ArrayBuffer,
  );
  if (!valid) return null;
  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
  if (typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > maxAgeMs) return null;
  return payload;
}

/** Cryptographically random, URL-safe token (for codes and session ids). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}
