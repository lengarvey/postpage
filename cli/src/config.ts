import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.postpage.ai";

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
    return parsed as Credentials;
  } catch {
    return null;
  }
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
