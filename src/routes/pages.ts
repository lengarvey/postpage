import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { problems } from "../lib/problems";
import { negotiatePageRepresentation } from "../lib/negotiate";
import {
  MAX_PAGE_BYTES,
  canView,
  createPage,
  getCurrentHtml,
  getPage,
  getSharedEmails,
  toPageResource,
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
