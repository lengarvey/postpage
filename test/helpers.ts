import { SELF } from "cloudflare:test";

export const API = "http://api.local";

export interface CreatedPage {
  uuid: string;
  hostname: string;
  url: string;
  resolver_url: string;
  current_revision: number | null;
  sharing: { sharing_mode: string; emails?: string[] };
  created_at: string;
  updated_at: string;
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  };
}

export async function createPage(
  token: string,
  html = "<!doctype html><html><body>hello</body></html>",
): Promise<CreatedPage> {
  const res = await SELF.fetch(`${API}/v1/pages`, {
    method: "POST",
    ...authed(token, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
    body: html,
  });
  if (res.status !== 201) {
    throw new Error(`createPage failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CreatedPage;
}

export async function setSharing(
  token: string,
  uuid: string,
  sharing: { sharing_mode: string; emails?: string[] },
): Promise<Response> {
  return SELF.fetch(`${API}/v1/pages/${uuid}/sharing`, {
    method: "PUT",
    ...authed(token, { headers: { "Content-Type": "application/json" } }),
    body: JSON.stringify(sharing),
  });
}
