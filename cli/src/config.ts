import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.postpage.ai";

/** Production WorkOS client id (a public identifier, not a secret). */
export const DEFAULT_WORKOS_CLIENT_ID = "client_01KXW9YTB8BGT4S5SGPN6PS0KF";

/** Static bearer token (dev stub or any externally minted token). */
export interface TokenAuth {
  kind: "token";
  token: string;
}

/** WorkOS CLI Auth tokens obtained via the device flow. */
export interface WorkosAuth {
  kind: "workos";
  client_id: string;
  access_token: string;
  refresh_token: string;
  user?: { id: string; email: string };
}

export interface Credentials {
  api_url: string;
  auth: TokenAuth | WorkosAuth;
}

function configDir(): string {
  const override = process.env["POSTPAGE_CONFIG_DIR"];
  if (override !== undefined && override !== "") return override;
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "postpage");
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export function readCredentials(): Credentials | null {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const legacy = migrateLegacyCredentials(parsed as Record<string, unknown>);
    if (legacy !== null) return legacy;
    return parsed as Credentials;
  } catch {
    return null;
  }
}

/**
 * The pre-workspace stopgap CLI stored WorkOS tokens flat
 * ({client_id, access_token, refresh_token, user}); adapt that layout so an
 * existing login survives the upgrade. Rewritten in the current layout on
 * the next token refresh.
 */
function migrateLegacyCredentials(
  parsed: Record<string, unknown>,
): Credentials | null {
  if (
    parsed["auth"] !== undefined ||
    typeof parsed["access_token"] !== "string" ||
    typeof parsed["refresh_token"] !== "string"
  ) {
    return null;
  }
  const user = parsed["user"] as { id?: unknown; email?: unknown } | undefined;
  return {
    api_url: DEFAULT_API_URL,
    auth: {
      kind: "workos",
      client_id:
        typeof parsed["client_id"] === "string"
          ? parsed["client_id"]
          : DEFAULT_WORKOS_CLIENT_ID,
      access_token: parsed["access_token"],
      refresh_token: parsed["refresh_token"],
      ...(typeof user?.id === "string" && typeof user?.email === "string"
        ? { user: { id: user.id, email: user.email } }
        : {}),
    },
  };
}

export function writeCredentials(credentials: Credentials): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Remove stored credentials. Returns whether anything was removed. */
export function deleteCredentials(): boolean {
  try {
    rmSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}
