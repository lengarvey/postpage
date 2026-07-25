import { HTML_CONTENT_TYPE, r2Key, type PageRow, type SharingMode } from "./pages";

/**
 * Content Security Policy for hosted pages: allow fully inline/self-contained
 * documents, block every external subresource and outbound connection.
 * See ARCHITECTURE.md "Hosted-page isolation policy".
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PAGE_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "bluetooth=()",
  "midi=()",
  "display-capture=()",
].join(", ");

/**
 * Security headers applied to every hosted-page response. Constructed at
 * response time from current sharing state; never stored with the HTML.
 * Non-public pages must not be embeddable by other sites.
 */
export function pageSecurityHeaders(
  sharingMode: SharingMode,
): Record<string, string> {
  const csp =
    sharingMode === "public" ? PAGE_CSP : `${PAGE_CSP}; frame-ancestors 'none'`;
  return {
    "Content-Type": HTML_CONTENT_TYPE,
    "Content-Security-Policy": csp,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, noarchive, nosnippet",
    "Permissions-Policy": PAGE_PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    // The authorization decision must never be cached; the immutable HTML is
    // cached separately (keyed by uuid + revision) behind this response.
    "Cache-Control": "no-store",
  };
}

/**
 * Read-through cache for immutable revision HTML. The cache key is uuid +
 * revision, so content updates naturally miss and sharing changes never
 * require a purge. Failures fall back to R2 silently. When a `waitUntil` is
 * provided, cache population runs after the response instead of delaying it.
 */
export async function getRevisionHtml(
  bucket: R2Bucket,
  uuid: string,
  revision: number,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ArrayBuffer | null> {
  const cacheKey = new Request(
    `https://revision-cache.postpage.internal/${uuid}/${revision}`,
  );
  let cache: Cache | undefined;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit !== undefined) return hit.arrayBuffer();
  } catch {
    cache = undefined;
  }

  const object = await bucket.get(r2Key(uuid, revision));
  if (object === null) return null;
  const bytes = await object.arrayBuffer();

  if (cache !== undefined) {
    try {
      // Constructing a Response from the buffer does not consume it.
      const put = cache
        .put(
          cacheKey,
          new Response(bytes, {
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
          }),
        )
        .catch(() => {
          // Cache writes are best-effort.
        });
      if (waitUntil !== undefined) waitUntil(put);
      else await put;
    } catch {
      // Cache writes are best-effort.
    }
  }
  return bytes;
}

/** Fetch the current HTML bytes for a page, or null when unavailable. */
export async function getCurrentHtml(
  bucket: R2Bucket,
  page: PageRow,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ArrayBuffer | null> {
  if (page.current_revision === null) return null;
  return getRevisionHtml(bucket, page.uuid, page.current_revision, waitUntil);
}
