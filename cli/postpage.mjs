#!/usr/bin/env node
/**
 * Postpage CLI — auth slice (see TODO.md item 2).
 *
 * Signs in via the OAuth 2.0 Device Authorization flow (WorkOS CLI Auth) and
 * manages the resulting tokens so scripts never handle passwords:
 *
 *   postpage login    browser sign-in once; stores tokens locally
 *   postpage token    prints a valid access token (auto-refreshes)
 *   postpage whoami   prints the signed-in user
 *   postpage logout   deletes stored credentials
 *
 * Usage with the API:
 *   curl -H "Authorization: Bearer $(postpage token)" https://api.postpage.ai/v1/pages
 *
 * Zero dependencies; requires Node 18+ (global fetch). Only the public
 * client id is embedded — no API secrets are involved in this flow.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WORKOS_API = "https://api.workos.com";
const DEFAULT_CLIENT_ID = "client_01KXW9YTB8BGT4S5SGPN6PS0KF";
const CLIENT_ID = process.env.POSTPAGE_CLIENT_ID || DEFAULT_CLIENT_ID;

const CONFIG_DIR = join(homedir(), ".config", "postpage");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

/** Seconds of validity below which an access token is refreshed early. */
const REFRESH_SLACK_SECONDS = 30;

function fail(message) {
  process.stderr.write(`postpage: ${message}\n`);
  process.exit(1);
}

async function readCredentials() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeCredentials(credentials) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

/** Unverified JWT payload decode — only used to read `exp` locally. */
function jwtPayload(token) {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function accessTokenIsFresh(accessToken) {
  const exp = jwtPayload(accessToken)?.exp;
  return (
    typeof exp === "number" &&
    exp - Date.now() / 1000 > REFRESH_SLACK_SECONDS
  );
}

async function workosForm(path, params) {
  const response = await fetch(`${WORKOS_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

/** Best-effort browser open; the printed URL is the fallback. */
function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).on(
    "error",
    () => {},
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  const { ok, body } = await workosForm("/user_management/authorize/device", {
    client_id: CLIENT_ID,
  });
  if (!ok) fail(`device authorization failed: ${JSON.stringify(body)}`);

  process.stderr.write(
    `Confirm this code in your browser: ${body.user_code}\n` +
      `  ${body.verification_uri_complete}\n`,
  );
  openBrowser(body.verification_uri_complete);

  let intervalSeconds = body.interval || 5;
  const deadline = Date.now() + (body.expires_in || 300) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const result = await workosForm("/user_management/authenticate", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: body.device_code,
      client_id: CLIENT_ID,
    });
    if (result.ok) {
      await writeCredentials({
        client_id: CLIENT_ID,
        access_token: result.body.access_token,
        refresh_token: result.body.refresh_token,
        user: {
          id: result.body.user?.id,
          email: result.body.user?.email,
        },
      });
      process.stderr.write(`Signed in as ${result.body.user?.email}\n`);
      return;
    }
    switch (result.body.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalSeconds += 5;
        break;
      case "access_denied":
        fail("sign-in was declined in the browser");
        break;
      default:
        fail(`sign-in failed: ${JSON.stringify(result.body)}`);
    }
  }
  fail("sign-in code expired before it was confirmed; run login again");
}

/**
 * Return stored credentials with a fresh access token, refreshing (and
 * persisting the rotated refresh token) when needed.
 */
async function freshCredentials() {
  const credentials = await readCredentials();
  if (!credentials?.refresh_token) {
    fail("not signed in; run: postpage login");
  }
  if (accessTokenIsFresh(credentials.access_token)) return credentials;

  const { ok, body } = await workosForm("/user_management/authenticate", {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
    client_id: credentials.client_id || CLIENT_ID,
  });
  if (!ok) {
    fail(
      `token refresh failed (${body.error || "unknown"}); run: postpage login`,
    );
  }
  const updated = {
    ...credentials,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  };
  await writeCredentials(updated);
  return updated;
}

async function token() {
  const credentials = await freshCredentials();
  process.stdout.write(`${credentials.access_token}\n`);
}

async function whoami() {
  const credentials = await readCredentials();
  if (!credentials?.user) fail("not signed in; run: postpage login");
  process.stdout.write(
    `${credentials.user.email} (${credentials.user.id})\n`,
  );
}

async function logout() {
  await rm(CREDENTIALS_PATH, { force: true });
  process.stderr.write("Signed out; local credentials deleted.\n");
}

const USAGE = `Usage: postpage <command>

Commands:
  login    Sign in via your browser (device authorization)
  token    Print a valid access token, refreshing if needed
  whoami   Show the signed-in user
  logout   Delete locally stored credentials
`;

const commands = { login, token, whoami, logout };
const command = commands[process.argv[2]];
if (!command) {
  process.stderr.write(USAGE);
  process.exit(process.argv[2] ? 1 : 0);
}
await command();
