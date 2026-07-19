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
  /**
   * "dev-stub" opts in to the pre-WorkOS bearer-token stub for API identity
   * (tests and local development only). Unset or anything else means real
   * WorkOS access-token verification.
   */
  AUTH_MODE?: string;
  /** WorkOS secret API key (wrangler secret). */
  WORKOS_API_KEY?: string;
  /** WorkOS client id for the environment (wrangler secret or var). */
  WORKOS_CLIENT_ID?: string;
  /**
   * Secret used to HMAC-sign the OAuth `state` parameter
   * (wrangler secret; any long random string).
   */
  AUTH_SECRET?: string;
  /**
   * Test-only override: a JSON JWKS used to verify access tokens instead of
   * fetching WorkOS's remote JWKS. Never set in deployed environments.
   */
  WORKOS_JWKS?: string;
}
