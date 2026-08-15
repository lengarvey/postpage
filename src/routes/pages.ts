import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { problems } from "../lib/problems";
import { negotiatePageRepresentation } from "../lib/negotiate";
import {
  HTML_CONTENT_TYPE,
  MAX_PAGE_BYTES,
  activateRevision,
  canView,
  createPage,
  getPage,
  getSharedEmails,
  getSharedEmailsForPages,
  listPages,
  markPagesDeleted,
  purgePageObjects,
  r2Key,
  refreshLastVisited,
  replaceSharing,
  reserveRevision,
  toPageResource,
  type ListCollection,
  type PageRow,
  type SharingMode,
} from "../lib/pages";
import { getCurrentHtml } from "../lib/serving";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { mintGuest } from "../lib/guests";
import { getOwnerPlan, getOwnerPlans } from "../lib/plans";
import {
  ANONYMOUS_DAILY_LIMIT,
  FREE_DAILY_LIMIT,
  consumeQuota,
  refundQuota,
  utcDay,
} from "../lib/quota";
import {
  identityFromRequest,
  requireAuth,
  type AuthVariables,
  type Identity,
} from "../middleware/auth";

type ApiContext = { Bindings: Env; Variables: AuthVariables };

/**
 * Validate an HTML upload request and return its bytes, or an error response.
 */
async function readHtmlUpload(
  c: Context<ApiContext>,
): Promise<ArrayBuffer | Response> {
  const contentType = c.req.header("Content-Type")?.split(";")[0]?.trim();
  if (contentType?.toLowerCase() !== "text/html") {
    return problems.unsupportedMediaType(
      c,
      "Uploads must use Content-Type: text/html; charset=utf-8.",
    );
  }

  const declaredLength = Number.parseInt(
    c.req.header("Content-Length") ?? "",
    10,
  );
  if (!Number.isNaN(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    return problems.pageTooLarge(c, MAX_PAGE_BYTES);
  }

  // Stream with a hard cap so a chunked upload without Content-Length cannot
  // buffer arbitrarily much memory before being rejected.
  const stream = c.req.raw.body;
  if (stream === null) return problems.emptyBody(c);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      return problems.pageTooLarge(c, MAX_PAGE_BYTES);
    }
    chunks.push(value);
  }
  if (total === 0) {
    return problems.emptyBody(c);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/**
 * Re-read a page after a mutation and serialize it. `knownEmails` skips the
 * permissions query when the caller already holds the current email list.
 */
async function updatedPageResponse(
  c: Context<ApiContext>,
  uuid: string,
  knownEmails?: string[],
): Promise<Response> {
  const updated = await getPage(c.env.DB, uuid);
  if (updated === null) return problems.pageNotFound(c);
  const emails =
    updated.sharing_mode !== "specific_users"
      ? []
      : (knownEmails ?? (await getSharedEmails(c.env.DB, uuid)));
  const plan = await getOwnerPlan(c.env.DB, updated.owner_id);
  return c.json(toPageResource(c.env, updated, emails, plan));
}

export const pagesApi = new Hono<ApiContext>();

/**
 * POST / is the one route that accepts unauthenticated requests (anonymous
 * publishing mints a guest account); every other route requires auth.
 */
pagesApi.post("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  let identity: Identity | null = null;
  if (authHeader !== undefined) {
    identity = await identityFromRequest(c.env, authHeader);
    if (identity === null) {
      return problems.unauthorized(c, "A valid bearer token is required.");
    }
  }

  const upload = await readHtmlUpload(c);
  if (upload instanceof Response) return upload;

  // Quota: signed-in users get a per-user counter; anonymous requests (and
  // guest tokens, since minting a fresh guest is free) count per client IP.
  const anonymous = identity === null || identity.guest === true;
  const quotaKey = anonymous
    ? `ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`
    : `user:${identity!.userId}`;
  const limit = anonymous ? ANONYMOUS_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const day = utcDay();
  if (!(await consumeQuota(c.env.DB, quotaKey, day, limit))) {
    return problems.quotaExceeded(c, limit);
  }

  // The guest token is derivable only from this response; it is stored
  // hashed and there is no recovery.
  let guestToken: string | undefined;
  if (identity === null) {
    const minted = await mintGuest(c.env.DB, new Date().toISOString());
    identity = { userId: minted.guestId, email: null, guest: true };
    guestToken = minted.token;
  }

  let page;
  try {
    page = await createPage(c.env, identity.userId, upload);
  } catch (error) {
    // Undo the resources this request claimed before failing, so a
    // transient R2/D1 error doesn't permanently burn a quota slot or leave
    // an orphaned, tokenless guest row behind.
    await Promise.allSettled([
      refundQuota(c.env.DB, quotaKey, day),
      guestToken === undefined
        ? Promise.resolve()
        : c.env.DB.prepare("DELETE FROM guests WHERE id = ?")
            .bind(identity.userId)
            .run(),
    ]);
    throw error;
  }
  const plan = identity.guest === true
    ? "anonymous"
    : await getOwnerPlan(c.env.DB, identity.userId);
  const resource = toPageResource(c.env, page, [], plan);
  return c.json(
    guestToken === undefined ? resource : { ...resource, guest_token: guestToken },
    201,
  );
});

pagesApi.use("*", requireAuth);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const COLLECTIONS: ReadonlySet<string> = new Set([
  "owned",
  "shared_with_me",
  "all",
]);

pagesApi.get("/", async (c) => {
  const collection = c.req.query("collection") ?? "owned";
  if (!COLLECTIONS.has(collection)) {
    return problems.validationError(
      c,
      "collection must be one of: owned, shared_with_me, all.",
    );
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = c.req.query("limit");
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isNaN(parsed) || String(parsed) !== rawLimit || parsed < 1) {
      return problems.validationError(c, "limit must be a positive integer.");
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  let after;
  const rawCursor = c.req.query("cursor");
  if (rawCursor !== undefined) {
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) {
      return problems.validationError(c, "cursor is not valid.");
    }
    after = decoded;
  }

  const identity = c.get("identity");
  const rows = await listPages(c.env.DB, identity, {
    collection: collection as ListCollection,
    limit,
    after,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const emailsByPage = await getSharedEmailsForPages(
    c.env.DB,
    pageRows
      .filter((p) => p.sharing_mode === "specific_users")
      .map((p) => p.uuid),
  );
  const plans = await getOwnerPlans(
    c.env.DB,
    pageRows.map((p) => p.owner_id),
  );

  const last = pageRows[pageRows.length - 1];
  return c.json({
    pages: pageRows.map((p) =>
      toPageResource(
        c.env,
        p,
        emailsByPage.get(p.uuid) ?? [],
        plans.get(p.owner_id) ?? "free",
      ),
    ),
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor({ updatedAt: last.updated_at, uuid: last.uuid })
        : null,
  });
});

/** Load a page and require the caller to be its owner. */
async function loadOwnedPage(
  c: Context<ApiContext>,
): Promise<PageRow | Response> {
  const page = await getPage(c.env.DB, c.req.param("uuid") ?? "");
  if (page === null) return problems.pageNotFound(c);
  if (c.get("identity").userId !== page.owner_id) {
    return problems.forbidden(c);
  }
  return page;
}

pagesApi.put("/:uuid", async (c) => {
  const page = await loadOwnedPage(c);
  if (page instanceof Response) return page;

  const upload = await readHtmlUpload(c);
  if (upload instanceof Response) return upload;

  const revision = await reserveRevision(c.env.DB, page.uuid);
  try {
    await activateRevision(
      c.env,
      page.uuid,
      revision,
      upload,
      new Date().toISOString(),
    );
  } catch (error) {
    // The current revision is unchanged; clean up the uploaded object so a
    // failed activation does not orphan it. The reserved number stays unused.
    await c.env.PAGES_BUCKET.delete(r2Key(page.uuid, revision)).catch(() => {});
    throw error;
  }

  return updatedPageResponse(c, page.uuid);
});

/** Shared with the MCP tool layer so email validity has one definition. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

pagesApi.put("/:uuid/sharing", async (c) => {
  // Guest pages stay locked to the viewer flow; guests cannot change sharing.
  if (c.get("identity").guest === true) {
    return problems.forbidden(c, "Guest pages cannot change sharing.");
  }
  const page = await loadOwnedPage(c);
  if (page instanceof Response) return page;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return problems.validationError(c, "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return problems.validationError(c, "Request body must be a JSON object.");
  }

  const { sharing_mode: mode, emails, ...rest } = body as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) {
    return problems.validationError(
      c,
      `Unknown fields: ${Object.keys(rest).join(", ")}.`,
    );
  }
  if (mode !== "private" && mode !== "public" && mode !== "specific_users") {
    return problems.validationError(
      c,
      "sharing_mode must be one of: private, public, specific_users.",
    );
  }
  if (mode === "specific_users") {
    if (
      !Array.isArray(emails) ||
      emails.length === 0 ||
      !emails.every(
        (e): e is string => typeof e === "string" && EMAIL_PATTERN.test(e),
      )
    ) {
      return problems.validationError(
        c,
        "specific_users requires a non-empty emails array of valid addresses.",
      );
    }
  } else if (emails !== undefined) {
    return problems.validationError(
      c,
      `emails is only allowed with sharing_mode "specific_users".`,
    );
  }

  // The stored form is lowercased, deduplicated, and sorted; compute it once
  // for both the write and the response.
  const normalizedEmails =
    mode === "specific_users"
      ? [...new Set((emails as string[]).map((e) => e.toLowerCase()))].sort()
      : [];
  await replaceSharing(c.env.DB, page.uuid, mode as SharingMode, normalizedEmails);

  return updatedPageResponse(c, page.uuid, normalizedEmails);
});

pagesApi.delete("/:uuid", async (c) => {
  const page = await loadOwnedPage(c);
  if (page instanceof Response) return page;

  // Two-phase deletion: the rows vanish before the response; the R2 purge
  // runs off the request path, with the daily cron as the crash backstop.
  await markPagesDeleted(c.env.DB, [page], new Date().toISOString());
  c.executionCtx.waitUntil(
    purgePageObjects(c.env, page.uuid).catch(() => {}),
  );
  return c.body(null, 204);
});

pagesApi.get("/:uuid", async (c) => {
  const representation = negotiatePageRepresentation(c.req.header("Accept"));
  if (representation === null) {
    return problems.notAcceptable(
      c,
      "Supported response types are text/html and application/json.",
    );
  }

  const page = await getPage(c.env.DB, c.req.param("uuid"));
  if (page === null) return problems.pageNotFound(c);

  const identity = c.get("identity");
  const sharedEmails =
    page.sharing_mode === "specific_users"
      ? await getSharedEmails(c.env.DB, page.uuid)
      : [];
  if (!canView(page, sharedEmails, identity)) {
    return problems.forbidden(c);
  }

  const html = await getCurrentHtml(c.env.PAGES_BUCKET, page, (promise) =>
    c.executionCtx.waitUntil(promise),
  );
  if (html === null) return problems.pageNotFound(c);

  // An API read of the content counts as a visit for free-tier expiry.
  refreshLastVisited(c.env.DB, c.executionCtx, page);

  c.header("Vary", "Accept");
  if (representation === "html") {
    return c.body(html, 200, {
      "Content-Type": HTML_CONTENT_TYPE,
      // The raw-HTML representation is meant for tooling (CLI pull), not for
      // rendering; keep browsers from sniffing or caching it.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  }
  const plan = await getOwnerPlan(c.env.DB, page.owner_id);
  return c.json({
    ...toPageResource(c.env, page, sharedEmails, plan),
    html: new TextDecoder().decode(html),
  });
});
