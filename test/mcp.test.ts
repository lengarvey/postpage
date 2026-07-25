import { SELF, env } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { API, authed, createPage } from "./helpers";

const HTML = "<!doctype html><html><body><h1>MCP</h1></body></html>";

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;

async function rpc(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  const message: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
  };
  if (params !== undefined) message.params = params;
  return SELF.fetch(`${API}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(message),
  });
}

async function rpcResult(
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await rpc(token, method, params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as RpcResponse;
  expect(body.error).toBeUndefined();
  return body.result as Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await rpcResult(token, "tools/call", {
    name,
    arguments: args,
  })) as unknown as ToolResult;
}

describe("OAuth discovery", () => {
  it("serves protected resource metadata pointing at AuthKit", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await SELF.fetch(`${API}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(`${API}/mcp`);
      // Normalized: the configured value carries a trailing slash.
      expect(body.authorization_servers).toEqual([
        "https://auth.test.postpage.ai",
      ]);
    }
  });

  it("challenges unauthenticated requests with resource metadata", async () => {
    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${API}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("rejects guest tokens: MCP is for signed-in accounts only", async () => {
    // Mint a guest token via an anonymous publish, exactly as a real
    // no-signup caller would obtain one.
    const created = await SELF.fetch(`${API}/v1/pages`, {
      method: "POST",
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: HTML,
    });
    expect(created.status).toBe(201);
    const { guest_token } = (await created.json()) as { guest_token: string };
    expect(guest_token).toBeTruthy();

    // The guest token works against the plain API...
    const list = await SELF.fetch(`${API}/v1/pages`, {
      headers: { Authorization: `Bearer ${guest_token}` },
    });
    expect(list.status).toBe(200);

    // ...but is challenged at the MCP endpoint.
    const res = await rpc(guest_token, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.message).toContain("signed-in");
  });

  // The dev-stub accepts any bearer string as an identity, so a JWT-shaped
  // stub token exercises the audience gate without real WorkOS signing.
  function stubJwt(aud?: string | string[]) {
    let jwt = new SignJWT(aud === undefined ? {} : { aud })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-aud-test")
      .setExpirationTime("5m");
    return jwt.sign(new TextEncoder().encode("dev-stub-not-verified"));
  }

  it("accepts tokens whose audience includes this MCP server", async () => {
    const token = await stubJwt(`${API}/mcp`);
    const res = await rpc(token, "ping");
    expect(res.status).toBe(200);
  });

  it("accepts tokens without an audience claim", async () => {
    const token = await stubJwt();
    const res = await rpc(token, "ping");
    expect(res.status).toBe(200);
  });

  it("rejects tokens bound to a different resource", async () => {
    const token = await stubJwt("https://some-other-server.example/mcp");
    const res = await rpc(token, "ping");
    expect(res.status).toBe(401);
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.message).toContain("audience");
  });

  it("rejects invalid bearer tokens", async () => {
    const res = await SELF.fetch(`${API}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("canonical MCP origin", () => {
  // PAGES_DOMAIN is pages.postpage.ai in tests, so the apex is postpage.ai
  // and the canonical MCP host is api.postpage.ai.
  it("308-redirects apex discovery to the api host", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await SELF.fetch(`http://postpage.ai${path}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(308);
      expect(res.headers.get("Location")).toBe(
        `http://api.postpage.ai${path}`,
      );
    }
  });

  it("fails fast on apex /mcp, naming the canonical URL", async () => {
    // Not a redirect: fetch strips Authorization on cross-origin redirects,
    // so a redirected connector would 401 forever. A 404 with the canonical
    // URL in the detail makes the misconfiguration visible immediately.
    const res = await SELF.fetch("http://postpage.ai/mcp", {
      method: "POST",
      ...authed("user-mcp", {
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toContain("http://api.postpage.ai/mcp");
  });

  it("does not redirect other apex routes", async () => {
    const res = await SELF.fetch("http://postpage.ai/healthz", {
      redirect: "manual",
    });
    expect(res.status).toBe(200);
  });
});

describe("Streamable HTTP protocol", () => {
  it("handles initialize with version negotiation", async () => {
    const result = await rpcResult("user-mcp", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo).toMatchObject({ name: "postpage" });
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(typeof result.instructions).toBe("string");
  });

  it("falls back to the latest supported protocol version", async () => {
    const result = await rpcResult("user-mcp", "initialize", {
      protocolVersion: "1999-01-01",
    });
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("answers an explicit id:null with an invalid-request error", async () => {
    const res = await SELF.fetch(`${API}/mcp`, {
      method: "POST",
      ...authed("user-mcp", {
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32600);
  });

  it("acknowledges client-to-server responses without a body", async () => {
    const res = await SELF.fetch(`${API}/mcp`, {
      method: "POST",
      ...authed("user-mcp", {
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await SELF.fetch(`${API}/mcp`, {
      method: "POST",
      ...authed("user-mcp", {
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("responds to ping", async () => {
    expect(await rpcResult("user-mcp", "ping")).toEqual({});
  });

  it("returns method-not-found for unknown methods", async () => {
    const res = await rpc("user-mcp", "resources/list");
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32601);
  });

  it("rejects malformed JSON and batch arrays", async () => {
    for (const body of ["{not json", "[]"]) {
      const res = await SELF.fetch(`${API}/mcp`, {
        method: "POST",
        ...authed("user-mcp", {
          headers: { "Content-Type": "application/json" },
        }),
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects GET and DELETE (stateless, no SSE stream)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await SELF.fetch(`${API}/mcp`, {
        method,
        ...authed("user-mcp"),
      });
      expect(res.status).toBe(405);
    }
  });
});

describe("tools/list", () => {
  it("lists all six tools with schemas", async () => {
    const result = await rpcResult("user-mcp", "tools/list");
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_page",
      "get_page",
      "list_pages",
      "publish_page",
      "set_page_sharing",
      "update_page",
    ]);
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect((tool.inputSchema as Record<string, unknown>).type).toBe("object");
    }
  });
});

describe("tools/call", () => {
  it("publish_page creates a private page and returns its URL", async () => {
    const result = await callTool("user-mcp", "publish_page", { html: HTML });
    expect(result.isError).toBeUndefined();
    const page = result.structuredContent as Record<string, unknown>;
    expect(page.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.url).toBe(`https://pages.postpage.ai/${page.uuid}`);
    expect(page.sharing).toEqual({ sharing_mode: "private" });
    // The text content mirrors the structured result for older clients.
    expect(result.content[0]?.text).toContain(String(page.url));

    // Stored byte-for-byte, exactly like an API upload.
    const object = await env.PAGES_BUCKET.get(
      `pages/${page.uuid}/00000001.html`,
    );
    expect(await object?.text()).toBe(HTML);
  });

  it("publish_page applies sharing_mode public", async () => {
    const result = await callTool("user-mcp", "publish_page", {
      html: HTML,
      sharing_mode: "public",
    });
    const page = result.structuredContent as Record<string, unknown>;
    expect(page.sharing).toEqual({ sharing_mode: "public" });
  });

  it("update_page creates a new revision", async () => {
    const page = await createPage("user-mcp");
    const result = await callTool("user-mcp", "update_page", {
      uuid: page.uuid,
      html: "<!doctype html><html><body>v2</body></html>",
    });
    const updated = result.structuredContent as Record<string, unknown>;
    expect(updated.current_revision).toBe(2);
  });

  it("get_page omits html unless include_html is set", async () => {
    const page = await createPage("user-mcp", HTML);
    const bare = await callTool("user-mcp", "get_page", { uuid: page.uuid });
    expect(bare.structuredContent?.html).toBeUndefined();
    expect(bare.structuredContent?.uuid).toBe(page.uuid);

    const full = await callTool("user-mcp", "get_page", {
      uuid: page.uuid,
      include_html: true,
    });
    expect(full.structuredContent?.html).toBe(HTML);
  });

  it("list_pages returns the caller's pages", async () => {
    const page = await createPage("user-mcp-list");
    const result = await callTool("user-mcp-list", "list_pages", {});
    const pages = result.structuredContent?.pages as Array<
      Record<string, unknown>
    >;
    expect(pages.map((p) => p.uuid)).toContain(page.uuid);
  });

  it("set_page_sharing switches to specific_users", async () => {
    const page = await createPage("user-mcp");
    const result = await callTool("user-mcp", "set_page_sharing", {
      uuid: page.uuid,
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
    expect(result.structuredContent?.sharing).toEqual({
      sharing_mode: "specific_users",
      emails: ["alex@example.com"],
    });
  });

  it("delete_page removes the page", async () => {
    const page = await createPage("user-mcp");
    const result = await callTool("user-mcp", "delete_page", {
      uuid: page.uuid,
    });
    expect(result.structuredContent).toEqual({
      deleted: true,
      uuid: page.uuid,
    });
    const gone = await callTool("user-mcp", "get_page", { uuid: page.uuid });
    expect(gone.isError).toBe(true);
  });

  it("maps API problems to tool errors (foreign page)", async () => {
    const page = await createPage("user-owner");
    const result = await callTool("user-intruder", "update_page", {
      uuid: page.uuid,
      html: HTML,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Access denied");
  });

  it("rejects specific_users without emails as invalid-params", async () => {
    const page = await createPage("user-mcp");
    for (const args of [
      { uuid: page.uuid, sharing_mode: "specific_users" },
      { uuid: page.uuid, sharing_mode: "specific_users", emails: [] },
      { uuid: page.uuid, sharing_mode: "specific_users", emails: ["not-an-email"] },
      { uuid: page.uuid, sharing_mode: "public", emails: ["a@example.com"] },
    ]) {
      const res = await rpc("user-mcp", "tools/call", {
        name: "set_page_sharing",
        arguments: args,
      });
      const body = (await res.json()) as RpcResponse;
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toContain("emails");
    }
  });

  it("rejects unsupported sharing_mode values as invalid-params", async () => {
    const page = await createPage("user-mcp");
    const badSharing = await rpc("user-mcp", "tools/call", {
      name: "set_page_sharing",
      arguments: { uuid: page.uuid, sharing_mode: "everyone" },
    });
    const sharingBody = (await badSharing.json()) as RpcResponse;
    expect(sharingBody.error?.code).toBe(-32602);
    expect(sharingBody.error?.message).toContain("sharing_mode");

    // publish_page only supports private/public; rejected before any page
    // is created, so a bad value cannot leave a half-applied result.
    const badPublish = await rpc("user-mcp", "tools/call", {
      name: "publish_page",
      arguments: { html: HTML, sharing_mode: "specific_users" },
    });
    const publishBody = (await badPublish.json()) as RpcResponse;
    expect(publishBody.error?.code).toBe(-32602);
    expect(publishBody.error?.message).toContain("sharing_mode");
  });

  it("rejects missing required arguments with invalid-params", async () => {
    const res = await rpc("user-mcp", "tools/call", {
      name: "publish_page",
      arguments: {},
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("html");
  });

  it("returns a tool error for unknown tool names", async () => {
    const result = await callTool("user-mcp", "make_coffee", {});
    expect(result.isError).toBe(true);
  });
});
