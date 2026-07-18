/**
 * Minimal Accept-header negotiation between text/html and application/json.
 * Missing header and `*` / `*∕*` map to text/html per the API contract.
 * Returns null when the header names only unsupported types (406).
 */
export type ApiRepresentation = "html" | "json";

export function negotiatePageRepresentation(
  accept: string | undefined,
): ApiRepresentation | null {
  if (accept === undefined || accept.trim() === "") return "html";

  let best: { rep: ApiRepresentation; q: number; order: number } | null = null;
  const entries = accept.split(",");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const [rawType, ...params] = entry.trim().split(";");
    const type = rawType?.trim().toLowerCase();
    if (!type) continue;

    let q = 1;
    for (const param of params) {
      const [k, v] = param.trim().split("=");
      if (k === "q" && v !== undefined) {
        const parsed = Number.parseFloat(v);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    if (q <= 0) continue;

    let rep: ApiRepresentation | null = null;
    if (type === "text/html" || type === "text/*" || type === "*/*") {
      rep = "html";
    } else if (type === "application/json" || type === "application/*") {
      rep = "json";
    }
    if (rep === null) continue;

    if (
      best === null ||
      q > best.q ||
      (q === best.q && rep === "html" && best.rep !== "html" && i < best.order)
    ) {
      best = { rep, q, order: i };
    }
  }
  return best?.rep ?? null;
}
