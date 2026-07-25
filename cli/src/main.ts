#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { ApiClient, type ListResponse, type PageResource } from "./api.js";
import {
  DEFAULT_API_URL,
  DEFAULT_WORKOS_CLIENT_ID,
  deleteCredentials,
  writeCredentials,
} from "./config.js";
import { CliError, usageError } from "./errors.js";
import { readBody, resolveBodySource } from "./input.js";
import { pollForDeviceTokens, requestDeviceAuthorization } from "./workos.js";

const USAGE = `Usage: postpage <command> [options]

Commands:
  publish [file]                    Create a page from a file or piped stdin
  update <uuid> [file]              Replace a page's HTML (new revision)
  pull <uuid> [--output <file>]     Fetch a page's current HTML
  list [--collection <c>]           List pages (owned | shared_with_me | all)
  sharing <uuid> <mode> [--email …] Set sharing: private | public | specific_users
  delete <uuid> [--force]           Delete a page (irreversible)
  login [--token <t>]               Log in via the browser, or store a token
  token                             Print a valid access token (refreshes)
  whoami                            Show the signed-in user
  logout                            Remove stored credentials

Global options:
  --json                            Machine-readable JSON output
  --api-url <url>                   API origin (default ${DEFAULT_API_URL},
                                    or POSTPAGE_API_URL / the stored login)

Authentication: \`postpage login\` (WorkOS device flow), or POSTPAGE_TOKEN.
\`publish\` also works with no login at all: it creates a guest account
(5 pages/day; pages are deleted 1 week after publish) and stores its token.`;

interface GlobalFlags {
  json: boolean;
  apiUrl: string | undefined;
}

type FlagSpec = Record<
  string,
  { type: "string" | "boolean"; multiple?: boolean }
>;

type ParsedValues = Record<string, string | boolean | string[] | undefined>;

/** Parse a command's args with the global flags always available. */
function parse(
  args: string[],
  options: FlagSpec,
  maxPositionals: number,
): { values: ParsedValues; positionals: string[]; flags: GlobalFlags } {
  let parsed: { values: ParsedValues; positionals: string[] };
  try {
    parsed = parseArgs({
      args,
      options: {
        ...options,
        json: { type: "boolean" },
        "api-url": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw usageError((error as Error).message);
  }
  if (parsed.positionals.length > maxPositionals) {
    throw usageError(`Unexpected argument: ${parsed.positionals[maxPositionals]}`);
  }
  const flags: GlobalFlags = {
    json: (parsed.values["json"] as boolean | undefined) ?? false,
    apiUrl: parsed.values["api-url"] as string | undefined,
  };
  return { values: parsed.values, positionals: parsed.positionals, flags };
}

function requireUuid(positionals: string[], index: number): string {
  const uuid = positionals[index];
  if (uuid === undefined) throw usageError("Missing <uuid> argument.");
  return uuid;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPage(page: PageResource, heading: string): void {
  const emails = page.sharing.emails;
  console.log(`${heading}
  url:       ${page.url}
  uuid:      ${page.uuid}
  revision:  ${page.current_revision}
  sharing:   ${page.sharing.sharing_mode}${
    emails !== undefined && emails.length > 0 ? ` (${emails.join(", ")})` : ""
  }`);
}

const HTML_UPLOAD_TYPE = "text/html; charset=utf-8";

async function cmdPublish(args: string[]): Promise<void> {
  const { positionals, flags } = parse(args, {}, 1);
  const body = readBody(resolveBodySource(positionals[0], process.stdin.isTTY));
  const client = new ApiClient(flags.apiUrl);
  const { guest_token: guestToken, ...page } =
    await client.requestJson<PageResource>("POST", "/v1/pages", {
      body,
      contentType: HTML_UPLOAD_TYPE,
      anonymous: true,
    });
  // The API returns the guest token exactly once; persist it so this CLI
  // can keep managing the page. Never echo it to output.
  if (guestToken !== undefined) client.saveGuestToken(guestToken);
  if (flags.json) {
    printJson(guestToken !== undefined ? { ...page, guest: true } : page);
    return;
  }
  printPage(page, guestToken !== undefined ? "Published anonymously." : "Published.");
  if (guestToken !== undefined) {
    console.log(
      "\nGuest credentials saved — this CLI can update, share, and delete the page.\n" +
        "Anonymous pages are deleted 1 week after publish; run `postpage login` for higher limits.",
    );
  }
}

async function cmdUpdate(args: string[]): Promise<void> {
  const { positionals, flags } = parse(args, {}, 2);
  const uuid = requireUuid(positionals, 0);
  const body = readBody(resolveBodySource(positionals[1], process.stdin.isTTY));
  const client = new ApiClient(flags.apiUrl);
  const page = await client.requestJson<PageResource>("PUT", `/v1/pages/${uuid}`, {
    body,
    contentType: HTML_UPLOAD_TYPE,
  });
  if (flags.json) printJson(page);
  else printPage(page, "Updated.");
}

async function cmdPull(args: string[]): Promise<void> {
  const { values, positionals, flags } = parse(args, { output: { type: "string" } }, 1);
  const uuid = requireUuid(positionals, 0);
  const output = values["output"] as string | undefined;
  const client = new ApiClient(flags.apiUrl);

  if (flags.json) {
    const page = await client.requestJson<PageResource & { html: string }>(
      "GET",
      `/v1/pages/${uuid}`,
      { accept: "application/json" },
    );
    if (output !== undefined) {
      writeFileSync(output, page.html);
      const { html: _html, ...metadata } = page;
      printJson({ ...metadata, output });
    } else {
      printJson(page);
    }
    return;
  }

  const response = await client.request("GET", `/v1/pages/${uuid}`, {
    accept: "text/html",
  });
  const html = new Uint8Array(await response.arrayBuffer());
  if (output !== undefined) {
    writeFileSync(output, html);
    console.log(`Wrote ${html.byteLength} bytes to ${output}.`);
  } else {
    process.stdout.write(html);
  }
}

const COLLECTIONS = ["owned", "shared_with_me", "all"];

async function cmdList(args: string[]): Promise<void> {
  const { values, flags } = parse(
    args,
    {
      collection: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      all: { type: "boolean" },
    },
    0,
  );
  const collection = (values["collection"] as string | undefined) ?? "owned";
  if (!COLLECTIONS.includes(collection)) {
    throw usageError(`--collection must be one of: ${COLLECTIONS.join(", ")}.`);
  }
  const fetchAll = (values["all"] as boolean | undefined) ?? false;
  if (fetchAll && values["cursor"] !== undefined) {
    throw usageError("--all and --cursor cannot be combined.");
  }

  const client = new ApiClient(flags.apiUrl);
  const query = (cursor: string | undefined): Record<string, string> => ({
    collection,
    ...(values["limit"] !== undefined ? { limit: values["limit"] as string } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });

  const pages: PageResource[] = [];
  let cursor = values["cursor"] as string | undefined;
  let nextCursor: string | null = null;
  do {
    const response: ListResponse = await client.requestJson<ListResponse>(
      "GET",
      "/v1/pages",
      { query: query(cursor) },
    );
    pages.push(...response.pages);
    nextCursor = response.next_cursor;
    cursor = nextCursor ?? undefined;
  } while (fetchAll && nextCursor !== null);

  if (flags.json) {
    printJson({ pages, next_cursor: fetchAll ? null : nextCursor });
    return;
  }
  if (pages.length === 0) {
    console.log("No pages.");
    return;
  }
  for (const page of pages) {
    console.log(
      `${page.uuid}  ${page.sharing.sharing_mode.padEnd(14)}  ${page.updated_at}  ${page.url}`,
    );
  }
  if (!fetchAll && nextCursor !== null) {
    console.log(`\nMore pages available: --cursor ${nextCursor}`);
  }
}

const SHARING_MODES = ["private", "public", "specific_users"];

async function cmdSharing(args: string[]): Promise<void> {
  const { values, positionals, flags } = parse(
    args,
    { email: { type: "string", multiple: true } },
    2,
  );
  const uuid = requireUuid(positionals, 0);
  const mode = positionals[1];
  if (mode === undefined || !SHARING_MODES.includes(mode)) {
    throw usageError(`Sharing mode must be one of: ${SHARING_MODES.join(", ")}.`);
  }
  const emails = (values["email"] as string[] | undefined) ?? [];
  if (mode === "specific_users" && emails.length === 0) {
    throw usageError("specific_users requires at least one --email.");
  }
  if (mode !== "specific_users" && emails.length > 0) {
    throw usageError("--email is only allowed with specific_users.");
  }

  const client = new ApiClient(flags.apiUrl);
  const page = await client.requestJson<PageResource>(
    "PUT",
    `/v1/pages/${uuid}/sharing`,
    {
      body: JSON.stringify({
        sharing_mode: mode,
        ...(mode === "specific_users" ? { emails } : {}),
      }),
      contentType: "application/json",
    },
  );
  if (flags.json) printJson(page);
  else printPage(page, "Sharing updated.");
}

async function cmdDelete(args: string[]): Promise<void> {
  const { values, positionals, flags } = parse(args, { force: { type: "boolean" } }, 1);
  const uuid = requireUuid(positionals, 0);
  const force = (values["force"] as boolean | undefined) ?? false;

  if (!force) {
    if (!process.stdin.isTTY) {
      throw usageError("Deletion is irreversible; pass --force to confirm.");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(
      `Permanently delete page ${uuid}? This cannot be undone. [y/N] `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.error("Aborted.");
      process.exitCode = 1;
      return;
    }
  }

  const client = new ApiClient(flags.apiUrl);
  await client.request("DELETE", `/v1/pages/${uuid}`);
  if (flags.json) printJson({ deleted: uuid });
  else console.log(`Deleted ${uuid}.`);
}

async function cmdLogin(args: string[]): Promise<void> {
  const { values, flags } = parse(
    args,
    { token: { type: "string" }, "client-id": { type: "string" } },
    0,
  );
  const apiUrl = flags.apiUrl ?? process.env["POSTPAGE_API_URL"] ?? DEFAULT_API_URL;

  const token = values["token"] as string | undefined;
  if (token !== undefined) {
    writeCredentials({ api_url: apiUrl, auth: { kind: "token", token } });
    if (flags.json) printJson({ api_url: apiUrl, auth: "token" });
    else console.log(`Stored token for ${apiUrl}.`);
    return;
  }

  const clientId =
    (values["client-id"] as string | undefined) ||
    process.env["POSTPAGE_WORKOS_CLIENT_ID"] ||
    DEFAULT_WORKOS_CLIENT_ID;

  const authorization = await requestDeviceAuthorization(clientId);
  console.log(`To log in, open:

  ${authorization.verification_uri_complete}

and confirm the code ${authorization.user_code}. Waiting for approval…`);
  const tokens = await pollForDeviceTokens(clientId, authorization);
  writeCredentials({
    api_url: apiUrl,
    auth: { kind: "workos", client_id: clientId, ...tokens },
  });
  if (flags.json) {
    printJson({ api_url: apiUrl, auth: "workos", user: tokens.user ?? null });
  } else {
    const who = tokens.user !== undefined ? ` as ${tokens.user.email}` : "";
    console.log(`Logged in${who}. Credentials stored for ${apiUrl}.`);
  }
}

async function cmdToken(args: string[]): Promise<void> {
  const { flags } = parse(args, {}, 0);
  const client = new ApiClient(flags.apiUrl);
  const token = await client.accessToken();
  if (flags.json) printJson({ token });
  else console.log(token);
}

async function cmdWhoami(args: string[]): Promise<void> {
  const { flags } = parse(args, {}, 0);
  const user = new ApiClient(flags.apiUrl).user();
  if (user === null) {
    throw new CliError(
      "No signed-in user recorded. Run `postpage login` (token-based auth has no identity).",
    );
  }
  if (flags.json) printJson(user);
  else console.log(`${user.email} (${user.id})`);
}

async function cmdLogout(args: string[]): Promise<void> {
  const { flags } = parse(args, {}, 0);
  const removed = deleteCredentials();
  if (flags.json) printJson({ logged_out: removed });
  else console.log(removed ? "Logged out." : "No stored credentials.");
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  publish: cmdPublish,
  update: cmdUpdate,
  pull: cmdPull,
  list: cmdList,
  sharing: cmdSharing,
  delete: cmdDelete,
  login: cmdLogin,
  token: cmdToken,
  whoami: cmdWhoami,
  logout: cmdLogout,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exitCode = command === undefined ? 2 : 0;
    return;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  await handler(rest);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});
