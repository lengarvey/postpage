import { CliError } from "./errors.js";

const WORKOS_API_URL = "https://api.workos.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 device authorization response. */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokens {
  access_token: string;
  refresh_token: string;
  user?: { id: string; email: string };
}

/** Pull the signed-in user out of a token response when present. */
function tokenUser(body: {
  user?: { id?: unknown; email?: unknown };
}): { user: { id: string; email: string } } | Record<string, never> {
  const user = body.user;
  return typeof user?.id === "string" && typeof user?.email === "string"
    ? { user: { id: user.id, email: user.email } }
    : {};
}

interface OauthError {
  error?: string;
  error_description?: string;
}

async function postForm(path: string, params: Record<string, string>): Promise<Response> {
  return fetch(`${WORKOS_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

/** Start the WorkOS CLI Auth device flow. */
export async function requestDeviceAuthorization(
  clientId: string,
): Promise<DeviceAuthorization> {
  const response = await postForm("/user_management/authorize/device", {
    client_id: clientId,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as OauthError;
    throw new CliError(
      `WorkOS device authorization failed (${response.status}): ` +
        `${body.error_description ?? body.error ?? "unknown error"}`,
    );
  }
  return (await response.json()) as DeviceAuthorization;
}

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Poll the token endpoint until the user approves, declines, or the device
 * code expires. Obeys `authorization_pending` and `slow_down` per RFC 8628.
 */
export async function pollForDeviceTokens(
  clientId: string,
  authorization: DeviceAuthorization,
): Promise<DeviceTokens> {
  let interval = Math.max(authorization.interval, 1);
  const deadline = Date.now() + authorization.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const response = await postForm("/user_management/authenticate", {
      grant_type: DEVICE_GRANT,
      device_code: authorization.device_code,
      client_id: clientId,
    });
    if (response.ok) {
      const body = (await response.json()) as Partial<DeviceTokens>;
      if (
        typeof body.access_token !== "string" ||
        typeof body.refresh_token !== "string"
      ) {
        throw new CliError("WorkOS returned an unexpected token response.");
      }
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        ...tokenUser(body),
      };
    }

    const body = (await response.json().catch(() => ({}))) as OauthError;
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        throw new CliError("Login was declined in the browser.");
      case "expired_token":
        throw new CliError("The login code expired. Run `postpage login` again.");
      default:
        throw new CliError(
          `WorkOS authentication failed (${response.status}): ` +
            `${body.error_description ?? body.error ?? "unknown error"}`,
        );
    }
  }
  throw new CliError("The login code expired. Run `postpage login` again.");
}

/**
 * Exchange a refresh token for fresh tokens. Returns null when the refresh
 * token is no longer valid (the user must log in again).
 */
export async function refreshTokens(
  clientId: string,
  refreshToken: string,
): Promise<DeviceTokens | null> {
  const response = await postForm("/user_management/authenticate", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Partial<DeviceTokens>;
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    return null;
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    ...tokenUser(body),
  };
}

/**
 * The `exp` claim of a JWT in epoch seconds, or null when the token is not a
 * decodable JWT. No signature check — the server verifies; this only decides
 * when to refresh proactively.
 */
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const exp = (decoded as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}
