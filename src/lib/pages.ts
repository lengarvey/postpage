import type { Env } from "../env";
import type { Identity } from "../middleware/auth";
import { generateUniqueHostname } from "./names";

/** Maximum upload size: 10 MiB. */
export const MAX_PAGE_BYTES = 10_485_760;

/** Canonical content type for uploaded and served page HTML. */
export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

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

function pagesBase(env: Env): URL {
  return new URL(env.PAGES_URL_BASE ?? `https://${env.PAGES_DOMAIN}`);
}

/** Canonical URL for a page: the friendly host plus the exact /s/{uuid} path. */
export function canonicalPageUrl(
  env: Env,
  hostname: string,
  uuid: string,
): string {
  const base = pagesBase(env);
  return `${base.protocol}//${hostname}.${base.host}/s/${uuid}`;
}

export function pageUrls(env: Env, page: PageRow): PageUrls {
  const base = pagesBase(env);
  return {
    url: canonicalPageUrl(env, page.hostname, page.uuid),
    resolver_url: `${base.protocol}//${base.host}/r/${page.uuid}`,
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
    // Best-effort cleanup so neither a content-less page row nor an
    // orphaned R2 object is left behind.
    await Promise.allSettled([
      env.DB.prepare("DELETE FROM pages WHERE uuid = ?").bind(uuid).run(),
      env.PAGES_BUCKET.delete(r2Key(uuid, 1)),
    ]);
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
    httpMetadata: { contentType: HTML_CONTENT_TYPE },
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

export type ListCollection = "owned" | "shared_with_me" | "all";

export interface ListOptions {
  collection: ListCollection;
  limit: number;
  after?: { updatedAt: string; uuid: string } | undefined;
}

/**
 * List pages visible to an identity in a collection, newest-updated first,
 * using keyset pagination on (updated_at, uuid) descending. Returns up to
 * `limit + 1` rows so the caller can detect whether more pages remain.
 */
export async function listPages(
  db: D1Database,
  identity: Identity,
  options: ListOptions,
): Promise<PageRow[]> {
  const { collection, limit, after } = options;

  const scopes: string[] = [];
  const binds: unknown[] = [];
  if (collection === "owned" || collection === "all") {
    scopes.push("p.owner_id = ?");
    binds.push(identity.userId);
  }
  if (
    (collection === "shared_with_me" || collection === "all") &&
    identity.email !== null
  ) {
    scopes.push(
      `(p.sharing_mode = 'specific_users' AND p.owner_id != ? AND EXISTS (
         SELECT 1 FROM page_permissions pp
         WHERE pp.page_uuid = p.uuid AND pp.email = ?))`,
    );
    binds.push(identity.userId, identity.email);
  }
  if (scopes.length === 0) return [];

  let keyset = "";
  if (after !== undefined) {
    keyset =
      "AND (p.updated_at < ? OR (p.updated_at = ? AND p.uuid < ?))";
    binds.push(after.updatedAt, after.updatedAt, after.uuid);
  }

  const { results } = await db
    .prepare(
      `SELECT p.* FROM pages p
       WHERE (${scopes.join(" OR ")}) ${keyset}
       ORDER BY p.updated_at DESC, p.uuid DESC
       LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<PageRow>();
  return results;
}

/** Batch-fetch shared emails for many pages, keyed by page uuid. */
export async function getSharedEmailsForPages(
  db: D1Database,
  uuids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (uuids.length === 0) return map;
  const placeholders = uuids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT page_uuid, email FROM page_permissions
       WHERE page_uuid IN (${placeholders}) ORDER BY email`,
    )
    .bind(...uuids)
    .all<{ page_uuid: string; email: string }>();
  for (const row of results) {
    const list = map.get(row.page_uuid) ?? [];
    list.push(row.email);
    map.set(row.page_uuid, list);
  }
  return map;
}

/**
 * Replace a page's sharing configuration atomically. `emails` must already be
 * validated, lowercased, and deduplicated.
 */
export async function replaceSharing(
  db: D1Database,
  uuid: string,
  mode: SharingMode,
  emails: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db.prepare("DELETE FROM page_permissions WHERE page_uuid = ?").bind(uuid),
    ...emails.map((email) =>
      db
        .prepare(
          "INSERT INTO page_permissions (page_uuid, email) VALUES (?, ?)",
        )
        .bind(uuid, email),
    ),
    db
      .prepare("UPDATE pages SET sharing_mode = ?, updated_at = ? WHERE uuid = ?")
      .bind(mode, now, uuid),
  ];
  await db.batch(statements);
}

/**
 * Delete a page: tombstone it and remove its rows in one atomic batch (all
 * API and page reads fail immediately), then purge every R2 revision object.
 */
export async function deletePage(env: Env, page: PageRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tombstones (uuid, hostname, owner_id, deleted_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(page.uuid, page.hostname, page.owner_id, new Date().toISOString()),
    // Cascades remove revisions and page_permissions.
    env.DB.prepare("DELETE FROM pages WHERE uuid = ?").bind(page.uuid),
  ]);

  // Purge by prefix rather than from the revisions table so objects written
  // by a concurrently racing update are removed as well.
  let cursor: string | undefined;
  do {
    const listing = await env.PAGES_BUCKET.list({
      prefix: `pages/${page.uuid}/`,
      cursor,
    });
    if (listing.objects.length > 0) {
      await env.PAGES_BUCKET.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
}
