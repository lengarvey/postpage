import { Hono } from "hono";
import type { Env } from "./env";
import { runExpirySweep } from "./lib/expiry";
import { problems } from "./lib/problems";
import { pagesApi } from "./routes/pages";
import { serveApp } from "./routes/serve";
import homepageHtml from "../design/homepage.html";

/**
 * API origin. Unknown paths return problem+json like every other API error.
 */
const apiApp = new Hono<{ Bindings: Env }>();
// Landing page on the main origin. The serving origin never serves it; its
// dispatch branch keeps its own 404 rules.
apiApp.get("/", (c) => c.html(homepageHtml));
apiApp.get("/healthz", (c) => c.json({ ok: true }));
apiApp.route("/v1/pages", pagesApi);
apiApp.notFound((c) => problems.notFound(c));

/**
 * Host-based dispatch:
 *  - `{PAGES_DOMAIN}` -> serving origin (untrusted uploaded content + /auth/*)
 *  - anything else    -> API (and the landing page on the apex)
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const host = new URL(request.url).hostname;
    if (host === env.PAGES_DOMAIN) {
      return serveApp.fetch(request, env, ctx);
    }
    return apiApp.fetch(request, env, ctx);
  },

  // Daily expiry sweep + deferred R2 purges (ARCHITECTURE.md "Plans,
  // quotas, and expiry"); bounded and idempotent, so a partial run just
  // leaves work for the next day.
  async scheduled(
    event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runExpirySweep(env, new Date(event.scheduledTime));
  },
};
