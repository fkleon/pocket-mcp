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
import { matchesPattern, isValidPattern, isBlocked } from "../mcp/config.ts";

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

/** A request to a route of the module, as the owner. */
const request = (path: string, body?: object) =>
    fetch(`${base}/api/x/mcp/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

/** A route's answer, which must be a success. */
async function route(path: string, body?: object) {
    const response = await request(path, body);

    assert.equal(response.status, 200, await response.clone().text());

    return response.json();
}

/** A server as the owner's page has it. */
const shown = async (name: string) =>
    (await route("state")).servers.find((each: { name: string }) => each.name === name);

/** Turn a server on, as the owner does from the page: for the entry that the page shows. */
const turnOn = async (name: string) =>
    route(`servers/${name}/on`, { on: true, fingerprint: (await shown(name)).fingerprint });

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

    await mcpCall("notes", "add_note", { text: "one" });
    assert.equal(existsSync(notesFile), false, "the server never ran");

    const seen = (await shown("notes")).fingerprint;

    await turnOn("notes");
    await mcpCall("notes", "add_note", { text: "one" });
    assert.equal(readFileSync(notesFile, "utf8"), "one\n");

    // Pi could change mcp.json with a shell: the changed entry stays off until the owner turns it on again, and a
    // page that still shows the old entry cannot turn on the new one.
    writeConfig({ notes: notes({ EXTRA: "1" }) });
    await route("reload", {});
    assert.equal((await request("servers/notes/on", { on: true, fingerprint: seen })).status, 409);

    const changed = await shown("notes");

    assert.equal(changed.pocket, "changed");
    assert.equal(changed.status, "off");
    assert.deepEqual(
        changed.parts
            .filter((part: { changed: boolean }) => part.changed)
            .map((part: { key: string }) => part.key),
        ["env.EXTRA"],
    );
    await mcpCall("notes", "add_note", { text: "two" });
    assert.equal(readFileSync(notesFile, "utf8"), "one\n");
});

test("what reaches Pi from a server is fenced, and holds none of its secrets", async () => {
    process.env.POCKET_MCP_TEST_SECRET = SECRET;
    writeConfig({
        notes: notes(),
        broken: { ...notes(), env: { FAIL_EARLY: "${POCKET_MCP_TEST_SECRET}" } },
    });
    await route("reload", {});
    await turnOn("notes");
    await turnOn("broken");

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

    await mcpCall("notes", "add_note", { text: "two" });
    assert.match(
        await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
        /mcp_call_read_only runs only/,
    );

    await route("servers/notes/plan-mode", { on: true });
    assert.match(await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"), /one/);
    await mcpCall("notes", "add_note", { text: "two" }, "mcp_call_read_only");
    assert.equal(readFileSync(notesFile, "utf8"), "one\n", "plan mode changed nothing");
    await app.commands.setPlan(session, owner(app), false);
});

// ── Unit tests for tool-filter helpers ──────────────────────────────────

test("matchesPattern matches exact names", () => {
    assert.equal(matchesPattern("add_note", "add_note"), true);
    assert.equal(matchesPattern("add_note", "list_notes"), false);
});

test("matchesPattern matches wildcards", () => {
    assert.equal(matchesPattern("*webFetch*", "mcp__radius__tools_webFetch_run"), true);
    assert.equal(matchesPattern("*webFetch*", "other_tool"), false);
    assert.equal(matchesPattern("tools_*_run", "tools_webFetch_run"), true);
    assert.equal(matchesPattern("tools_*_run", "tools_other_run"), true);
    assert.equal(matchesPattern("tools_*_run", "other"), false);
    assert.equal(matchesPattern("*", "any_tool_name"), true);
    assert.equal(matchesPattern("mcp__*", "mcp__radius__add_note"), true);
});

test("matchesPattern handles special regex characters", () => {
    assert.equal(matchesPattern("a.b", "a.b"), true);
    assert.equal(matchesPattern("a.b", "axb"), false);
    assert.equal(matchesPattern("a+b", "a+b"), true);
    assert.equal(matchesPattern("a+b", "aab"), false);
});

test("isValidPattern validates allowed characters", () => {
    assert.equal(isValidPattern("exact_name"), true);
    assert.equal(isValidPattern("with-dash"), true);
    assert.equal(isValidPattern("with.dot"), true);
    assert.equal(isValidPattern("wild*card"), true);
    assert.equal(isValidPattern("mixed_pattern-1.0*test"), true);
    assert.equal(isValidPattern(""), false);
    assert.equal(isValidPattern(123 as never), false);
    assert.equal(isValidPattern(null as never), false);
    assert.equal(isValidPattern({} as never), false);
});

test("isBlocked checks per-server blocked patterns", () => {
    const settings = {
        servers: {
            radius: { approved: "abc", blocked: ["tools_webFetch*"] },
            other: { approved: "def", blocked: [] },
        },
    };

    assert.equal(isBlocked(settings, "radius", "tools_webFetch_run"), true);
    assert.equal(isBlocked(settings, "radius", "tools_webFetch_url"), true);
    assert.equal(isBlocked(settings, "radius", "other_tool"), false);
    assert.equal(isBlocked(settings, "other", "tools_webFetch_run"), false);
    assert.equal(isBlocked(settings, "nonexistent", "any_tool"), false);
});

test("isBlocked with no blocked array returns false", () => {
    const settings: Parameters<typeof isBlocked>[0] = {
        servers: { server: { approved: "x" } },
    };

    assert.equal(isBlocked(settings, "server", "any_tool"), false);
});

// ── Integration tests for tool-filter route ─────────────────────────────

test("block route blocks a tool and excludes it from mcp_tools", async () => {
    writeConfig({ notes: notes() });
    await route("reload", {});
    await until(async () => (await route("state")).servers.length === 1, "mcp.json read");
    await turnOn("notes");

    // Initially all tools are visible
    const stateBefore = await shown("notes");
    const allTools = stateBefore.tools;

    assert.ok(allTools.length > 0, "server has tools");

    // Block the first tool
    const toolToBlock = allTools[0].name;

    const response = await request(`servers/notes/block`, {
        action: "block",
        pattern: toolToBlock,
    });

    assert.equal(response.status, 200);

    // Tool should still appear in state but marked as blocked
    const stateAfter = await shown("notes");
    const blockedTool = stateAfter.tools.find((t: { name: string }) => t.name === toolToBlock);

    assert.ok(blockedTool?.blocked, "tool is marked as blocked in state");

    // Blocked tools should not appear in mcp_tools output
    const toolsList = await ask("mcp_tools", {});

    assert.match(toolsList, /MCP tools/);
    assert.doesNotMatch(
        toolsList,
        new RegExp(toolToBlock),
        "blocked tool should not appear in mcp_tools output",
    );

    // Unclassified call to blocked tool should fail
    const callResult = await mcpCall("notes", toolToBlock);

    assert.match(callResult, /blocked/i);

    // Unblock the tool
    const unblockResponse = await request(`servers/notes/block`, {
        action: "unblock",
        pattern: toolToBlock,
    });

    assert.equal(unblockResponse.status, 200);

    // Tool should no longer be blocked
    const stateUnblocked = await shown("notes");
    const unblockedTool = stateUnblocked.tools.find(
        (t: { name: string }) => t.name === toolToBlock,
    );

    assert.ok(!unblockedTool?.blocked, "tool is no longer blocked after unblock");
});

test("block route rejects invalid patterns", async () => {
    writeConfig({ notes: notes() });
    await route("reload", {});
    await until(async () => (await route("state")).servers.length === 1, "mcp.json read");

    // Empty pattern
    const emptyResponse = await request(`servers/notes/block`, {
        action: "block",
        pattern: "",
    });

    assert.equal(emptyResponse.status, 400);

    // Invalid characters (spaces)
    const spaceResponse = await request(`servers/notes/block`, {
        action: "block",
        pattern: "invalid pattern",
    });

    assert.equal(spaceResponse.status, 400);

    // Invalid action
    const actionResponse = await request(`servers/notes/block`, {
        action: "delete",
        pattern: "some_tool",
    });

    assert.equal(actionResponse.status, 400);
});

test("block route persists across reloads", async () => {
    writeConfig({ notes: notes() });
    await route("reload", {});
    await until(async () => (await route("state")).servers.length === 1, "mcp.json read");
    await turnOn("notes");

    const stateBefore = await shown("notes");
    const toolToBlock = stateBefore.tools[0].name;

    // Block the tool
    await request(`servers/notes/block`, {
        action: "block",
        pattern: toolToBlock,
    });

    // Reload the config
    await route("reload", {});

    // Tool should still be blocked after reload
    const stateAfter = await shown("notes");
    const blockedTool = stateAfter.tools.find((t: { name: string }) => t.name === toolToBlock);

    assert.ok(blockedTool?.blocked, "tool remains blocked after reload");
});

test("block route handles non-existent server", async () => {
    const response = await request(`servers/nonexistent/block`, {
        action: "block",
        pattern: "some_tool",
    });

    assert.equal(response.status, 404);
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
