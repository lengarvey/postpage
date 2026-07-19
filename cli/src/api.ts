import {
  DEFAULT_API_URL,
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./config.js";
import { CliError } from "./errors.js";
import { jwtExpiry, refreshTokens } from "./workos.js";

/** How close to expiry (seconds) an access token is refreshed proactively. */
const REFRESH_MARGIN_SECONDS = 30;

const LOGIN_HINT =
  "Not logged in. Run `postpage login`, or set POSTPAGE_TOKEN.";

export interface PageResource {
  uuid: string;
  hostname: string;
  url: string;
  resolver_url: string;
  current_revision: number;
  sharing: { sharing_mode: string; emails?: string[] };
  created_at: string;
  updated_at: string;
}

export interface ListResponse {
  pages: PageResource[];
  next_cursor: string | null;
}

interface ProblemDocument {
  code?: string;
  title?: string;
  detail?: string;
}

/**
 * Authenticated client for the Postpage API. Resolves the bearer token from
 * POSTPAGE_TOKEN or stored credentials, refreshing WorkOS tokens when they
 * are about to expire (and once more on a 401).
 */
export class ApiClient {
  private readonly apiUrl: string;
  private credentials: Credentials | null;
  private readonly envToken: string | undefined;

  constructor(apiUrlOverride?: string) {
    this.credentials = readCredentials();
    this.envToken = process.env["POSTPAGE_TOKEN"] || undefined;
    this.apiUrl = (
      apiUrlOverride ??
      process.env["POSTPAGE_API_URL"] ??
      this.credentials?.api_url ??
      DEFAULT_API_URL
    ).replace(/\/+$/, "");
  }

  private async bearerToken(): Promise<string> {
    if (this.envToken !== undefined) return this.envToken;
    const auth = this.credentials?.auth;
    if (auth === undefined) throw new CliError(LOGIN_HINT);
    if (auth.kind === "token") return auth.token;

    const expiry = jwtExpiry(auth.access_token);
    if (expiry !== null && expiry - Date.now() / 1000 < REFRESH_MARGIN_SECONDS) {
      await this.refresh();
      return (this.credentials!.auth as { access_token: string }).access_token;
    }
    return auth.access_token;
  }

  /** Refresh stored WorkOS tokens; throws when re-login is required. */
  private async refresh(): Promise<void> {
    const auth = this.credentials?.auth;
    if (auth === undefined || auth.kind !== "workos") {
      throw new CliError(LOGIN_HINT);
    }
    const tokens = await refreshTokens(auth.client_id, auth.refresh_token);
    if (tokens === null) {
      throw new CliError("Your session has expired. Run `postpage login` again.");
    }
    this.credentials = {
      api_url: this.credentials!.api_url,
      auth: { ...auth, ...tokens },
    };
    writeCredentials(this.credentials);
  }

  private canRefresh(): boolean {
    return this.envToken === undefined && this.credentials?.auth.kind === "workos";
  }

  async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string>;
      body?: Uint8Array | string;
      contentType?: string;
      accept?: string;
    } = {},
  ): Promise<Response> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.bearerToken()}`,
      };
      if (options.contentType !== undefined) {
        headers["Content-Type"] = options.contentType;
      }
      if (options.accept !== undefined) headers["Accept"] = options.accept;
      return fetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
    };

    let response = await send();
    if (response.status === 401 && this.canRefresh()) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await apiError(response);
    return response;
  }

  async requestJson<T>(
    method: string,
    path: string,
    options?: Parameters<ApiClient["request"]>[2],
  ): Promise<T> {
    const response = await this.request(method, path, options);
    return (await response.json()) as T;
  }
}

/** Turn a non-2xx API response (RFC 9457 problem+json) into a CliError. */
async function apiError(response: Response): Promise<CliError> {
  let problem: ProblemDocument = {};
  try {
    problem = (await response.json()) as ProblemDocument;
  } catch {
    // Not problem+json (e.g. an intermediary error page); fall through.
  }
  const detail = problem.detail ?? problem.title ?? response.statusText;
  const code = problem.code !== undefined ? ` [${problem.code}]` : "";
  if (response.status === 401) {
    return new CliError(`Authentication failed${code}: ${detail} ${LOGIN_HINT}`);
  }
  return new CliError(`API error (${response.status})${code}: ${detail}`);
}
