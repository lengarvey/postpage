import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ProblemInit {
  status: ContentfulStatusCode;
  code: string;
  title: string;
  detail?: string;
}

/**
 * Build an RFC 9457 application/problem+json response with a stable
 * machine-readable `code`.
 */
export function problem(c: Context, init: ProblemInit): Response {
  const body: Record<string, unknown> = {
    type: `https://postpage.ai/problems/${init.code.replaceAll("_", "-")}`,
    title: init.title,
    status: init.status,
    code: init.code,
  };
  if (init.detail !== undefined) {
    body.detail = init.detail;
  }
  return c.body(JSON.stringify(body), init.status, {
    "Content-Type": "application/problem+json; charset=utf-8",
  });
}

export const problems = {
  unauthorized: (c: Context, detail?: string) =>
    problem(c, {
      status: 401,
      code: "unauthorized",
      title: "Authentication required",
      detail,
    }),
  forbidden: (c: Context, detail?: string) =>
    problem(c, {
      status: 403,
      code: "forbidden",
      title: "Access denied",
      detail,
    }),
  notFound: (c: Context) =>
    problem(c, {
      status: 404,
      code: "not_found",
      title: "Resource not found",
    }),
  pageNotFound: (c: Context) =>
    problem(c, {
      status: 404,
      code: "page_not_found",
      title: "Page not found",
    }),
  notAcceptable: (c: Context, detail?: string) =>
    problem(c, {
      status: 406,
      code: "not_acceptable",
      title: "Requested response type is not supported",
      detail,
    }),
  unsupportedMediaType: (c: Context, detail?: string) =>
    problem(c, {
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported request content type",
      detail,
    }),
  pageTooLarge: (c: Context, maxBytes: number) =>
    problem(c, {
      status: 413,
      code: "page_too_large",
      title: "Page exceeds the upload limit",
      detail: `The maximum page size is ${maxBytes} bytes.`,
    }),
  quotaExceeded: (c: Context, limit: number) =>
    problem(c, {
      status: 429,
      code: "quota_exceeded",
      title: "Daily page limit reached",
      detail: `The limit is ${limit} pages per UTC day. Try again tomorrow.`,
    }),
  emptyBody: (c: Context) =>
    problem(c, {
      status: 400,
      code: "empty_body",
      title: "Request body must not be empty",
    }),
  validationError: (c: Context, detail: string) =>
    problem(c, {
      status: 400,
      code: "validation_error",
      title: "Request is invalid",
      detail,
    }),
  internalError: (c: Context) =>
    problem(c, {
      status: 500,
      code: "internal_error",
      title: "Internal server error",
    }),
};
