import { Hono } from "hono";
import type { Env } from "./env";
import { pagesApi } from "./routes/pages";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/v1/pages", pagesApi);

export default app;
