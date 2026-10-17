// The MCP module's browser part, for the owner: a page with the servers of mcp.json, their state and tools, and what
// the owner can do with each (turn it on or off here, reconnect, sign in, allow plan mode), and how calls of the
// module's tools show. Text from the servers (tool names, descriptions, errors) shows as text only.
export const pocketApi = 1;

/** A plug, as a 24×24 stroked path like the app's own icons. */
const PLUG = "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4";

const STATUS = {
    off: ["Off", ""],
    connecting: ["Connecting…", "busy"],
    connected: ["Connected", "ok"],
    failed: ["Failed", "err"],
    disconnected: ["Disconnected", "warn"],
    "needs-sign-in": ["Needs sign-in", "warn"],
    closed: ["Stopped", ""],
};

const text = (value) => (typeof value === "string" ? value : "");

export default function setup(pocket) {
    const { html, useEffect, useState, useCallback, Loader, Switch } = pocket;

    pocket.style("style.css");

    /** The rail button, with the count of servers that need the owner. */
    const rail = pocket.rail({ id: "servers", title: "MCP", iconPath: PLUG, page: "servers" });

    /** Each state that the tab reads also sets the count. */
    const read = async () => {
        const state = await pocket.api("state");

        rail.update({ badge: state.attention });

        return state;
    };

    /** One server: its switch, its state, what to do, and its tools. */
    function ServerCard({ server, act, busy }) {
        const run = (path, body) => act(path, body).catch(() => undefined);
        const [address, setAddress] = useState("");
        const [pasteError, setPasteError] = useState(null);
        const [label, kind] = STATUS[server.status] ?? [server.status, ""];
        const live = server.pocket === "on" && server.enabledInFile && !server.unsupported;
        const canTurnOn = server.enabledInFile && !server.unsupported;
        const visible = server.tools.filter((tool) => !tool.hidden).length;

        const paste = async () => {
            setPasteError(null);

            try {
                await act(`servers/${encodeURIComponent(server.name)}/sign-in/paste`, {
                    address,
                });
                setAddress("");
            } catch (failure) {
                setPasteError(failure.message);
            }
        };

        return html`<section class="mcp-server">
            <div class="mcp-head">
                <div class="mcp-title">
                    <strong class="mcp-name">${server.name}</strong>
                    <span class=${`mcp-pill ${live ? kind : ""}`}>
                        ${live ? label : server.pocket === "changed" ? "Changed" : "Off"}
                    </span>
                </div>
                <${Switch}
                    on=${server.pocket === "on"}
                    label=${`Run ${server.name} in Pi Pocket`}
                    disabled=${busy || (!canTurnOn && server.pocket !== "on")}
                    onChange=${() =>
                        run(`servers/${encodeURIComponent(server.name)}/on`, {
                            on: server.pocket !== "on",
                        })}
                />
            </div>
            <div class="mono small mcp-target">${server.kind} · ${server.target}</div>
            ${
                server.description
                    ? html`<div class="small muted">${server.description}</div>`
                    : null
            }
            ${
                server.unsupported
                    ? html`<div class="small mcp-warn">Pi Pocket cannot run it: ${server.unsupported}.</div>`
                    : null
            }
            ${
                !server.enabledInFile
                    ? html`<div class="small muted">Off in mcp.json ("enabled": false).</div>`
                    : null
            }
            ${
                server.pocket === "changed" && server.enabledInFile
                    ? html`<div class="small mcp-warn">
                      Its entry in mcp.json changed after you turned it on. Check the entry, then turn
                      it on again.
                  </div>`
                    : null
            }
            ${
                live && server.error
                    ? html`<pre class="mono small mcp-error">${server.error}</pre>`
                    : null
            }
            ${
                server.signIn
                    ? html`<div class="mcp-signin">
                      <a
                          class="button primary"
                          href=${server.signIn}
                          target="_blank"
                          rel="noopener noreferrer"
                      >
                          Open the sign-in page
                      </a>
                      <p class="small muted">
                          The sign-in ends on a page of this machine (127.0.0.1). When that page does
                          not load, for example on a phone, copy its address and paste it here.
                      </p>
                      <div class="mcp-row">
                          <input
                              class="mcp-input"
                              type="url"
                              placeholder="http://127.0.0.1:…/callback?code=…"
                              value=${address}
                              onInput=${(event) => setAddress(event.currentTarget.value)}
                          />
                          <button class="button" disabled=${busy || !address} onClick=${paste}>
                              Finish
                          </button>
                          <button
                              class="button"
                              disabled=${busy}
                              onClick=${() =>
                                  run(
                                      `servers/${encodeURIComponent(server.name)}/sign-in/cancel`,
                                      {},
                                  )}
                          >
                              Cancel
                          </button>
                      </div>
                      ${pasteError ? html`<div class="error-box">${pasteError}</div>` : null}
                  </div>`
                    : null
            }
            ${
                live
                    ? html`<div class="mcp-row">
                      <button
                          class="button"
                          disabled=${busy}
                          onClick=${() => run(`servers/${encodeURIComponent(server.name)}/reconnect`, {})}
                      >
                          Reconnect
                      </button>
                      ${
                          server.oauth && !server.signIn
                              ? html`<button
                                class=${`button ${server.status === "needs-sign-in" ? "primary" : ""}`}
                                disabled=${busy}
                                onClick=${() =>
                                    run(`servers/${encodeURIComponent(server.name)}/sign-in`, {})}
                            >
                                Sign in
                            </button>`
                              : null
                      }
                      ${
                          server.oauth && server.signedIn
                              ? html`<button
                                class="button"
                                disabled=${busy}
                                onClick=${() =>
                                    run(`servers/${encodeURIComponent(server.name)}/sign-out`, {})}
                            >
                                Sign out
                            </button>`
                              : null
                      }
                  </div>`
                    : null
            }
            <div class="setting">
                <div class="grow small">
                    Plan mode may run the tools that this server marks read-only
                </div>
                <${Switch}
                    on=${server.planMode}
                    label=${`Plan mode may run read-only tools of ${server.name}`}
                    disabled=${busy}
                    onChange=${() =>
                        run(`servers/${encodeURIComponent(server.name)}/plan-mode`, {
                            on: !server.planMode,
                        })}
                />
            </div>
            ${
                server.tools.length > 0
                    ? html`<details class="mcp-tools">
                      <summary class="small">
                          ${visible} ${visible === 1 ? "tool" : "tools"} for Pi${
                              visible < server.tools.length
                                  ? `, ${server.tools.length - visible} hidden`
                                  : ""
                          }
                      </summary>
                      <ul>
                          ${server.tools.map(
                              (tool) =>
                                  html`<li class=${tool.hidden ? "mcp-hidden" : ""}>
                                      <div>
                                          <span class="mono small">${tool.name}</span>
                                          ${
                                              tool.readOnly
                                                  ? html`<span class="mcp-tag">read-only</span>`
                                                  : null
                                          }
                                          ${
                                              tool.hidden
                                                  ? html`<span class="mcp-tag">hidden</span>`
                                                  : null
                                          }
                                      </div>
                                      ${
                                          tool.title || tool.description
                                              ? html`<div class="small muted mcp-about">
                                                ${[tool.title, tool.description]
                                                    .filter(Boolean)
                                                    .join(" — ")}
                                            </div>`
                                              : null
                                      }
                                  </li>`,
                          )}
                      </ul>
                  </details>`
                    : null
            }
        </section>`;
    }

    /** The page: what mcp.json has, and each server. */
    function Servers() {
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);

        const refresh = useCallback(async () => {
            try {
                setState(await read());
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        }, []);

        /** Do one thing on the server, then show the new state. A sign-in opens its page from a link. */
        const act = useCallback(async (path, body) => {
            setBusy(true);

            try {
                const answer = await pocket.api(path, body);

                if (answer && Array.isArray(answer.servers)) {
                    rail.update({ badge: answer.attention });
                    setState(answer);
                } else {
                    await refresh();
                }

                setError(null);
            } catch (failure) {
                setError(failure.message);

                throw failure;
            } finally {
                setBusy(false);
            }
        }, []);

        const quietly = (path, body) => act(path, body).catch(() => undefined);

        useEffect(() => {
            void refresh();

            return pocket.on("changed", () => void refresh());
        }, []);

        if (!state) {
            return error
                ? html`<div class="error-box">${error}</div>
                      <button class="button" onClick=${refresh}>Try again</button>`
                : html`<${Loader} label="Reading mcp.json" />`;
        }

        return html`<div class="mcp-page">
            <p class="small muted">
                The servers of <span class="mono">${state.file}</span>, which Pi's terminal app uses
                too. Each server is a program that runs with your rights. Pi Pocket starts a server only
                after you turn it on here, and again after each change to its entry. Lancet Guard does
                not check the calls of MCP tools.
            </p>
            <div class="mcp-row">
                <button class="button" disabled=${busy} onClick=${() => quietly("reload", {})}>
                    Read mcp.json again
                </button>
            </div>
            ${error ? html`<div class="error-box">${error}</div>` : null}
            ${
                state.errors.length > 0
                    ? html`<div class="error-box">
                      ${state.errors.map((each) => html`<div class="small">${each}</div>`)}
                  </div>`
                    : null
            }
            ${
                state.servers.length === 0
                    ? html`<p class="muted">
                      mcp.json has no servers. Add one with <span class="mono">pi mcp add</span> in a
                      terminal, then read mcp.json again.
                  </p>`
                    : state.servers.map(
                          (server) =>
                              html`<${ServerCard}
                              key=${server.name}
                              server=${server}
                              act=${act}
                              busy=${busy}
                          />`,
                      )
            }
        </div>`;
    }

    pocket.page({ id: "servers", title: "MCP servers", component: Servers });

    pocket.launcher({
        id: "servers",
        label: "MCP servers",
        detail: "servers, tools, sign-in",
        iconPath: PLUG,
        keywords: ["mcp", "model context protocol", "tools"],
        page: "servers",
    });

    // The count on the rail: now, at each change, and when the browser shows the page again from its cache (events
    // that came while it was away are lost).
    const recount = () => void read().catch(() => undefined);

    pocket.onDispose(pocket.on("changed", (data) => rail.update({ badge: data?.attention ?? 0 })));
    window.addEventListener("pageshow", recount);
    pocket.onDispose(() => window.removeEventListener("pageshow", recount));
    recount();

    const where = (args) => [text(args.server), text(args.tool)].filter(Boolean).join(" · ");

    pocket.toolCall({
        tool: "mcp_tools",
        iconPath: PLUG,
        label: () => "list MCP tools",
        subject: (args) => [text(args.server), text(args.query)].filter(Boolean).join(" · "),
        summary: () => ({ verb: "listed MCP tools" }),
    });

    for (const tool of ["mcp_call", "mcp_call_read_only"]) {
        pocket.toolCall({
            tool,
            iconPath: PLUG,
            label: () => "call MCP tool",
            subject: where,
            summary: () => ({ verb: "called", noun: "MCP tool", by: "tool" }),
        });
    }
}
