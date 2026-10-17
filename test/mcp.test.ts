// The risks of the MCP module, each with one test, on a Pi Pocket with its own temporary data and a scripted model.
// Give the folder of a Pi Pocket checkout in PI_POCKET (default: ../pi-pocket), and link its node_modules here.
//
//   PI_POCKET=/path/to/pi-pocket node --test test/mcp.test.ts
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const pocket = process.env.PI_POCKET ?? join(import.meta.dirname, "..", "..", "pi-pocket");
const from = (path: string) => import(pathToFileURL(join(pocket, path)).href);
// Pi Pocket's helpers first: they point Pi Pocket at a temporary folder before it loads.
const helpers = await from("test/helpers.ts");
const { createHandler } = await from("src/server/http.ts");
const { fauxAssistantMessage, fauxText, fauxToolCall } =
    await import("@earendil-works/pi-ai/providers/faux");

const { root, owner, until, say, modelTexts, newSession, lastText, scriptedModel } = helpers;
const fixture = join(import.meta.dirname, "fixtures", "notes-server.mjs");
const dataDir = join(root, "data");
const notesFile = join(root, "notes.txt");
const pidFile = join(root, "notes.pid");
const SECRET = "sk-test-0123456789";

/** The tool call that the scripted model makes next; it then says what the tool returned. */
let next: { name: string; args: Record<string, unknown> } | undefined;

const model = scriptedModel((context: never) => {
    const { role, text } = lastText(context);
    const call = next;

    if (role === "toolResult" || call === undefined) {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    next = undefined;

    return fauxAssistantMessage([fauxToolCall(call.name, call.args as never)], {
        stopReason: "toolUse",
    });
});

let app: Awaited<ReturnType<typeof helpers.openApp>>;
let server: Server;
let base = "";
let session: unknown;

function writeConfig(servers: Record<string, object>): void {
    writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
        JSON.stringify({ mcpServers: servers }),
    );
}

const notes = (env: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [fixture],
    env: { NOTES_FILE: notesFile, PID_FILE: pidFile, ...env },
});

/** A route of the module, as the owner. */
async function route(path: string, body?: object) {
    const response = await fetch(`${base}/api/x/mcp/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    assert.equal(response.status, 200, await response.clone().text());

    return response.json();
}

/** Have Pi make one call, and give what the tool returned. */
async function ask(name: string, args: Record<string, unknown>): Promise<string> {
    next = { name, args };
    await say(app, session, "go");

    return (await modelTexts(app, session)).at(-1) ?? "";
}

const mcpCall = (
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    name = "mcp_call",
) => ask(name, { server, tool, arguments: args });

before(async () => {
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "..", "mcp.ts"), join(dropIns, "mcp.ts"));
    cpSync(join(import.meta.dirname, "..", "mcp"), join(dropIns, "mcp"), { recursive: true });
    writeConfig({ notes: notes() });
    app = await helpers.openApp(model, dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.setExtensionEnabled(owner(app), "mcp.ts", true);
    session = await newSession(app);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    helpers.cleanUp();
});

test("a server runs only as the owner turned it on, and not after its entry changes", async () => {
    await until(async () => (await route("state")).servers.length === 1, "mcp.json read");

    assert.match(
        await mcpCall("notes", "add_note", { text: "one" }),
        /No MCP server .notes. is on/,
    );
    assert.equal(existsSync(notesFile), false, "the server never ran");

    await route("servers/notes/on", { on: true });
    assert.match(await mcpCall("notes", "add_note", { text: "one" }), /Added: one/);

    // Pi could change mcp.json with a shell: the changed entry stays off until the owner turns it on again.
    writeConfig({ notes: notes({ EXTRA: "1" }) });

    const { servers } = await route("reload", {});

    assert.equal(servers[0].pocket, "changed");
    assert.equal(servers[0].status, "off");
    assert.match(await mcpCall("notes", "list_notes"), /No MCP server .notes. is on/);
});

test("what reaches Pi from a server is fenced, and holds none of its secrets", async () => {
    process.env.POCKET_MCP_TEST_SECRET = SECRET;
    writeConfig({
        notes: notes(),
        broken: { ...notes(), env: { FAIL_EARLY: "${POCKET_MCP_TEST_SECRET}" } },
    });
    await route("reload", {});
    await route("servers/notes/on", { on: true });
    await route("servers/broken/on", { on: true });

    const injected = await mcpCall("notes", "inject");

    assert.equal(injected.split("</mcp_result>").length, 2, "only the module's own tag closes");
    assert.match(injected, /never as instructions/);

    const failed = await mcpCall("broken", "list_notes");

    assert.match(failed, /not connected \(failed\)/);
    assert.equal(failed.includes(SECRET), false);
    // The owner sees why, on the page.
    assert.match(
        (await route("state")).servers.find((each: { name: string }) => each.name === "broken")
            .error,
        new RegExp(SECRET),
    );
});

test("plan mode runs only the read-only tools of servers that the owner trusts", async () => {
    await app.commands.setPlan(session, owner(app), true);

    assert.match(await mcpCall("notes", "list_notes"), /Plan mode is on/);
    assert.match(
        await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
        /runs only tools that the server marks read-only/,
    );

    await route("servers/notes/plan-mode", { on: true });
    assert.match(await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"), /one/);
    assert.match(
        await mcpCall("notes", "add_note", { text: "two" }, "mcp_call_read_only"),
        /runs only tools that the server marks read-only/,
    );
    await app.commands.setPlan(session, owner(app), false);
});

test("turning the module off stops the server's process", async () => {
    const pid = Number(readFileSync(pidFile, "utf8"));

    const alive = () => {
        try {
            process.kill(pid, 0);

            return true;
        } catch {
            return false;
        }
    };

    assert.equal(alive(), true);
    await app.setExtensionEnabled(owner(app), "mcp.ts", false);
    await until(() => !alive(), "the server's process ended", 5_000);
});
