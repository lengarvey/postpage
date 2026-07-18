import type { SharingMode } from "./pages";

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
    "Content-Type": "text/html; charset=utf-8",
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
 * require a purge. Failures fall back to R2 silently.
 */
export async function getRevisionHtml(
  bucket: R2Bucket,
  uuid: string,
  revision: number,
  r2Key: string,
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

  const object = await bucket.get(r2Key);
  if (object === null) return null;
  const bytes = await object.arrayBuffer();

  if (cache !== undefined) {
    try {
      await cache.put(
        cacheKey,
        new Response(bytes.slice(0), {
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        }),
      );
    } catch {
      // Cache writes are best-effort.
    }
  }
  return bytes;
}
