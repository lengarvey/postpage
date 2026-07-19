import { Hono } from "hono";
import type { Env } from "./env";
import { problems } from "./lib/problems";
import { pagesApi } from "./routes/pages";
import { resolveRedirect, resolverApp, serveApp } from "./routes/serve";
import homepageHtml from "../design/homepage.html";

/**
 * API origin. The resolver route is also mounted here so local development
 * against localhost works without host tricks; unknown paths return
 * problem+json like every other API error.
 */
const apiApp = new Hono<{ Bindings: Env }>();
// Landing page on the main origin. Hosted-page origins and the pages apex
// never serve it; their dispatch branches keep their own 404 rules.
apiApp.get("/", (c) => c.html(homepageHtml));
apiApp.get("/healthz", (c) => c.json({ ok: true }));
apiApp.route("/v1/pages", pagesApi);
apiApp.get("/r/:uuid", resolveRedirect);
apiApp.notFound((c) => problems.notFound(c));

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
