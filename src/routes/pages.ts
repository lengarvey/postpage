import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { problems } from "../lib/problems";
import { negotiatePageRepresentation } from "../lib/negotiate";
import {
  MAX_PAGE_BYTES,
  activateRevision,
  canView,
  createPage,
  deletePage,
  getCurrentHtml,
  getPage,
  getSharedEmails,
  replaceSharing,
  reserveRevision,
  toPageResource,
  type PageRow,
  type SharingMode,
} from "../lib/pages";
import { requireAuth, type AuthVariables } from "../middleware/auth";

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

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_PAGE_BYTES) {
    return problems.pageTooLarge(c, MAX_PAGE_BYTES);
  }
  if (body.byteLength === 0) {
    return problems.emptyBody(c);
  }
  return body;
}

export const pagesApi = new Hono<ApiContext>();

pagesApi.use("*", requireAuth);

pagesApi.post("/", async (c) => {
  const upload = await readHtmlUpload(c);
  if (upload instanceof Response) return upload;

  const identity = c.get("identity");
  const page = await createPage(c.env, identity.userId, upload);
  return c.json(toPageResource(c.env, page, []), 201);
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
  await activateRevision(
    c.env,
    page.uuid,
    revision,
    upload,
    new Date().toISOString(),
  );

  const updated = await getPage(c.env.DB, page.uuid);
  if (updated === null) return problems.pageNotFound(c);
  const sharedEmails = await getSharedEmails(c.env.DB, page.uuid);
  return c.json(toPageResource(c.env, updated, sharedEmails));
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

pagesApi.put("/:uuid/sharing", async (c) => {
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

  await replaceSharing(
    c.env.DB,
    page.uuid,
    mode as SharingMode,
    mode === "specific_users" ? (emails as string[]) : [],
  );

  const updated = await getPage(c.env.DB, page.uuid);
  if (updated === null) return problems.pageNotFound(c);
  const sharedEmails = await getSharedEmails(c.env.DB, page.uuid);
  return c.json(toPageResource(c.env, updated, sharedEmails));
});

pagesApi.delete("/:uuid", async (c) => {
  const page = await loadOwnedPage(c);
  if (page instanceof Response) return page;

  await deletePage(c.env, page);
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
  const sharedEmails = await getSharedEmails(c.env.DB, page.uuid);
  if (!canView(page, sharedEmails, identity)) {
    return problems.forbidden(c);
  }

  const html = await getCurrentHtml(c.env, page);
  if (html === null) return problems.pageNotFound(c);

  c.header("Vary", "Accept");
  if (representation === "html") {
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }
  return c.json({
    ...toPageResource(c.env, page, sharedEmails),
    html: new TextDecoder().decode(html),
  });
});
