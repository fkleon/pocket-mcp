#!/usr/bin/env node
// A small streamable HTTP MCP server for the live test, with an OAuth authorization server of its own when started
// with --oauth: discovery, dynamic client registration, PKCE, refresh tokens, and a page to approve the sign-in.
// It answers with JSON (no event streams) and keeps everything in memory.
//
//   node test/fixtures/http-server.mjs [port] [--oauth]
//   GET /admin/expire     forget the access tokens (the refresh tokens stay), to test a refresh
//   GET /admin/revoke     forget all tokens, to test a new sign-in
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8951);
const oauth = process.argv.includes("--oauth");
const base = `http://127.0.0.1:${port}`;
const clients = new Map();
const codes = new Map();
const access = new Set();
const refresh = new Set();
const sessions = new Set();

const token = () => randomBytes(18).toString("base64url");

const tools = [
    {
        name: "echo",
        description: "Echo the text back.",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "add",
        description: "Add two numbers.",
        inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
        },
    },
];

function json(response, status, body, headers = {}) {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
}

async function body(request) {
    const chunks = [];

    for await (const chunk of request) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function tokens(response) {
    const accessToken = token();
    const refreshToken = token();

    access.add(accessToken);
    refresh.add(refreshToken);
    json(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
    });
}

function rpc(message) {
    switch (message.method) {
        case "initialize":
            return {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "http-fixture", version: "1.0.0" },
            };
        case "tools/list":
            return { tools };

        case "tools/call": {
            const args = message.params.arguments ?? {};

            if (message.params.name === "echo") {
                return { content: [{ type: "text", text: String(args.text) }] };
            }

            if (message.params.name === "add") {
                return {
                    content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }],
                };
            }

            return { content: [{ type: "text", text: "No such tool" }], isError: true };
        }

        case "ping":
            return {};
        default:
            return undefined;
    }
}

createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const path = url.pathname;

    if (path.startsWith("/.well-known/oauth-protected-resource") && oauth) {
        return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }

    if (path === "/.well-known/oauth-authorization-server" && oauth) {
        return json(response, 200, {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
    }

    if (path === "/register" && request.method === "POST") {
        const metadata = JSON.parse(await body(request));
        const client = { ...metadata, client_id: token(), client_id_issued_at: Date.now() };

        clients.set(client.client_id, client);

        return json(response, 201, client);
    }

    if (path === "/authorize") {
        const client = clients.get(url.searchParams.get("client_id"));
        const redirect = url.searchParams.get("redirect_uri");

        if (!client || !client.redirect_uris.includes(redirect)) {
            response.writeHead(400).end("Unknown client or redirect address");

            return;
        }

        const approve = new URL("/approve", base);

        approve.search = url.search;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
            `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign in</title><h1>Test sign-in</h1><p>${client.client_name} asks to use the test MCP server.</p><p><a id="approve" href="${approve.href.replace(/"/g, "&quot;")}">Approve</a></p>`,
        );

        return;
    }

    if (path === "/approve") {
        const code = token();

        codes.set(code, {
            challenge: url.searchParams.get("code_challenge"),
            redirect: url.searchParams.get("redirect_uri"),
            client: url.searchParams.get("client_id"),
        });

        const back = new URL(url.searchParams.get("redirect_uri"));

        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: back.href }).end();

        return;
    }

    if (path === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await body(request));

        if (form.get("grant_type") === "authorization_code") {
            const saved = codes.get(form.get("code"));
            const challenge = createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url");

            codes.delete(form.get("code"));

            if (
                !saved ||
                saved.challenge !== challenge ||
                saved.redirect !== form.get("redirect_uri")
            ) {
                return json(response, 400, { error: "invalid_grant" });
            }

            return tokens(response);
        }

        if (
            form.get("grant_type") === "refresh_token" &&
            refresh.delete(form.get("refresh_token"))
        ) {
            return tokens(response);
        }

        return json(response, 400, { error: "invalid_grant" });
    }

    if (path === "/admin/expire") {
        access.clear();

        return json(response, 200, { expired: true });
    }

    if (path === "/admin/revoke") {
        access.clear();
        refresh.clear();

        return json(response, 200, { revoked: true });
    }

    if (path === "/mcp") {
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");

        if (oauth && !access.has(bearer)) {
            response.writeHead(401, {
                "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            });
            response.end();

            return;
        }

        if (request.method === "GET") {
            response.writeHead(405).end();

            return;
        }

        if (request.method === "DELETE") {
            sessions.delete(request.headers["mcp-session-id"]);
            response.writeHead(200).end();

            return;
        }

        const message = JSON.parse(await body(request));

        if (message.id === undefined) {
            response.writeHead(202).end();

            return;
        }

        const headers = {};

        if (message.method === "initialize") {
            const session = token();

            sessions.add(session);
            headers["mcp-session-id"] = session;
        }

        const result = rpc(message);

        return json(
            response,
            200,
            result === undefined
                ? {
                      jsonrpc: "2.0",
                      id: message.id,
                      error: { code: -32601, message: "Unknown method" },
                  }
                : { jsonrpc: "2.0", id: message.id, result },
            headers,
        );
    }

    response.writeHead(404).end();
}).listen(port, "127.0.0.1", () => {
    console.log(`MCP test server on ${base}/mcp${oauth ? " (OAuth)" : ""}`);
});
