import type { Env } from "../env";
import type { Identity } from "../middleware/auth";
import { generateUniqueHostname } from "./names";

/** Maximum upload size: 10 MiB. */
export const MAX_PAGE_BYTES = 10_485_760;

export type SharingMode = "private" | "public" | "specific_users";

export interface PageRow {
  uuid: string;
  hostname: string;
  owner_id: string;
  current_revision: number | null;
  next_revision: number;
  sharing_mode: SharingMode;
  created_at: string;
  updated_at: string;
}

export function r2Key(uuid: string, revision: number): string {
  return `pages/${uuid}/${String(revision).padStart(8, "0")}.html`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function getPage(
  db: D1Database,
  uuid: string,
): Promise<PageRow | null> {
  if (!isValidUuid(uuid)) return null;
  return db
    .prepare("SELECT * FROM pages WHERE uuid = ?")
    .bind(uuid.toLowerCase())
    .first<PageRow>();
}

export async function getSharedEmails(
  db: D1Database,
  uuid: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT email FROM page_permissions WHERE page_uuid = ? ORDER BY email",
    )
    .bind(uuid)
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

/** May this identity view the page content? Owners can always view. */
export function canView(
  page: PageRow,
  sharedEmails: string[],
  identity: Identity | null,
): boolean {
  if (page.sharing_mode === "public") return true;
  if (identity === null) return false;
  if (identity.userId === page.owner_id) return true;
  if (page.sharing_mode === "specific_users" && identity.email !== null) {
    return sharedEmails.includes(identity.email);
  }
  return false;
}

export interface PageUrls {
  url: string;
  resolver_url: string;
}

export function pageUrls(env: Env, page: PageRow): PageUrls {
  return {
    url: `https://${page.hostname}.${env.PAGES_DOMAIN}/s/${page.uuid}`,
    resolver_url: `https://${env.PAGES_DOMAIN}/r/${page.uuid}`,
  };
}

export interface SharingConfig {
  sharing_mode: SharingMode;
  emails?: string[];
}

export function sharingConfig(
  page: PageRow,
  sharedEmails: string[],
): SharingConfig {
  if (page.sharing_mode === "specific_users") {
    return { sharing_mode: "specific_users", emails: sharedEmails };
  }
  return { sharing_mode: page.sharing_mode };
}

export interface PageResource extends PageUrls {
  uuid: string;
  hostname: string;
  current_revision: number | null;
  sharing: SharingConfig;
  created_at: string;
  updated_at: string;
}

export function toPageResource(
  env: Env,
  page: PageRow,
  sharedEmails: string[],
): PageResource {
  return {
    uuid: page.uuid,
    hostname: page.hostname,
    ...pageUrls(env, page),
    current_revision: page.current_revision,
    sharing: sharingConfig(page, sharedEmails),
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
}

/**
 * Create a page with its first revision. The page row is inserted first,
 * reserving the uuid, hostname, and revision 1; the HTML object is then
 * uploaded to R2 and the revision activated. If the upload fails the page row
 * is removed so no content-less page is left behind.
 */
export async function createPage(
  env: Env,
  ownerId: string,
  html: ArrayBuffer,
): Promise<PageRow> {
  const uuid = crypto.randomUUID();
  const hostname = await generateUniqueHostname(env.DB);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO pages (uuid, hostname, owner_id, current_revision, next_revision, sharing_mode, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 2, 'private', ?, ?)`,
  )
    .bind(uuid, hostname, ownerId, now, now)
    .run();

  try {
    await activateRevision(env, uuid, 1, html, now);
  } catch (error) {
    await env.DB.prepare("DELETE FROM pages WHERE uuid = ?").bind(uuid).run();
    throw error;
  }

  const page = await getPage(env.DB, uuid);
  if (page === null) throw new Error("page vanished during create");
  return page;
}

/**
 * Upload the HTML object for an already-reserved revision number, record the
 * revision, and advance the page's current revision pointer. The pointer only
 * moves forward, so a slow older upload can never displace a newer revision.
 */
export async function activateRevision(
  env: Env,
  uuid: string,
  revision: number,
  html: ArrayBuffer,
  now: string,
): Promise<void> {
  const key = r2Key(uuid, revision);
  await env.PAGES_BUCKET.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO revisions (page_uuid, revision, r2_key, size, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(uuid, revision, key, html.byteLength, now),
    env.DB.prepare(
      `UPDATE pages
       SET current_revision = ?1, updated_at = ?2
       WHERE uuid = ?3
         AND (current_revision IS NULL OR current_revision < ?1)`,
    ).bind(revision, now, uuid),
  ]);
}

/**
 * Atomically reserve the next revision number for a page.
 * Returns the reserved number.
 */
export async function reserveRevision(
  db: D1Database,
  uuid: string,
): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE pages SET next_revision = next_revision + 1
       WHERE uuid = ? RETURNING next_revision`,
    )
    .bind(uuid)
    .first<{ next_revision: number }>();
  if (row === null) throw new Error("page not found while reserving revision");
  return row.next_revision - 1;
}

/** Fetch the current HTML bytes for a page, or null when unavailable. */
export async function getCurrentHtml(
  env: Env,
  page: PageRow,
): Promise<ArrayBuffer | null> {
  if (page.current_revision === null) return null;
  const object = await env.PAGES_BUCKET.get(
    r2Key(page.uuid, page.current_revision),
  );
  if (object === null) return null;
  return object.arrayBuffer();
}
