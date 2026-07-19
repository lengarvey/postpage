export interface Env {
  DB: D1Database;
  PAGES_BUCKET: R2Bucket;
  /** Base domain for hosted pages; used to match request hostnames. */
  PAGES_DOMAIN: string;
  /**
   * Optional override for the origin used when *rendering* page URLs,
   * e.g. "http://pages.localhost:8787" in local dev (.dev.vars) so returned
   * URLs are clickable. Defaults to `https://{PAGES_DOMAIN}`.
   */
  PAGES_URL_BASE?: string;
}
