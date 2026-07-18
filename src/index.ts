import { Hono } from "hono";
import type { Env } from "./env";
import { pagesApi } from "./routes/pages";
import { resolverApp, serveApp } from "./routes/serve";

/**
 * API origin. The resolver routes are also mounted here so local development
 * against localhost works without host tricks.
 */
const apiApp = new Hono<{ Bindings: Env }>();
apiApp.get("/healthz", (c) => c.json({ ok: true }));
apiApp.route("/v1/pages", pagesApi);
apiApp.route("/", resolverApp);

/**
 * Host-based dispatch:
 *  - `{friendly}.{PAGES_DOMAIN}` -> hosted-page origin (untrusted content)
 *  - `{PAGES_DOMAIN}`            -> resolver only (trusted, never serves HTML)
 *  - anything else               -> API
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const host = new URL(request.url).hostname;
    if (host === env.PAGES_DOMAIN) {
      return resolverApp.fetch(request, env, ctx);
    }
    if (host.endsWith(`.${env.PAGES_DOMAIN}`)) {
      return serveApp.fetch(request, env, ctx);
    }
    return apiApp.fetch(request, env, ctx);
  },
};
