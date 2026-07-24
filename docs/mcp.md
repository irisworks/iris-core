---
title: MCP Servers
description: Connect external toolsets via the Model Context Protocol — config format, hot-reload, security posture, and verification.
---

# MCP Servers

Iris can connect to [Model Context Protocol](https://modelcontextprotocol.io)
servers and expose their tools directly to the model, alongside her built-in
tools. This is how hosted integrations (Linear, Notion, GitHub's remote MCP
server) and the `npx`-based MCP ecosystem plug in without custom code per
integration.

Two transports are supported:

- **stdio** — a local subprocess (e.g. `npx -y @modelcontextprotocol/server-everything`)
- **http** — a remote Streamable HTTP server, with optional bearer-token headers

## Configuration

Servers are declared in `<workspace>/meta/mcp.json` (for a standard install,
`/iris/data/meta/mcp.json` — next to `channels.json`). The file is optional;
no file means no servers and no overhead.

```json
{
  "servers": {
    "everything": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": { "SOME_VAR": "value" },
      "enabled": true,
      "allowedTools": ["echo", "get*"],
      "timeoutMs": 30000,
      "connectTimeoutMs": 10000
    },
    "linear": {
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_MCP_TOKEN}" }
    }
  }
}
```

Field reference (per server; the key is the server name):

| Field | Required | Default | Purpose |
|---|---|---|---|
| `transport` | yes | — | `"stdio"` or `"http"` |
| `command` / `args` / `env` | stdio only | — / `[]` / — | Subprocess to spawn; `env` is merged over a minimal inherited environment |
| `url` / `headers` | http only | — / — | Streamable HTTP endpoint and extra request headers |
| `enabled` | no | `true` | `false` keeps the entry but closes the connection |
| `allowedTools` | no | all tools | Names to expose; trailing `*` acts as a prefix wildcard |
| `timeoutMs` | no | `30000` | Per-tool-call timeout |
| `connectTimeoutMs` | no | `10000` | Connect + tool-listing timeout |

### Secrets

Any string value may reference environment variables as `${VAR}`, expanded
from the runtime's environment (i.e. `/iris/.env`). Keep tokens in `.env`
and reference them — never inline secrets in `mcp.json`. A referenced but
unset variable fails only that server, with the reason shown in status.
Note `.env` changes need `systemctl restart iris` to take effect;
`mcp.json` changes do not.

## Hot-reload

`mcp.json` is re-checked before every message (a content-hash comparison, so
the steady-state cost is one file read). Added servers are connected, removed
or changed ones are closed and reconnected — the next message can use tools
of a server added seconds earlier. Connections are lazy: nothing connects at
process startup, so a slow or broken server can never block boot.

## Tool naming

Tools are exposed as `mcp__<server>__<tool>` (e.g. `mcp__linear__list_issues`),
so provenance is visible in tool-call events and collisions with built-in
tools are impossible. The connected servers, their tool counts, and any
failures are listed in Iris's system prompt, so she always knows what she has.

## Failure behavior

MCP support is degradation-proof by design:

- A missing config file, malformed JSON, invalid entry, unreachable server,
  or crashed subprocess never crashes the runtime or blocks a message — the
  problem is recorded and surfaced in the system prompt and `/mcp/status`.
- Failed servers are retried automatically (about once a minute) on
  subsequent messages, so a crashed stdio server self-heals.
- Individual tools whose schemas fail validation are dropped with a log
  line; the rest of the server's tools still work.
- Tool output is truncated with the same line/byte limits as bash output, so
  a chatty server can't blow the context window.

## Verification

```bash
curl -s 127.0.0.1:3000/mcp/status | jq
```

The `GET /mcp/status` route (internal API, honors `IRIS_API_TOKEN` auth)
refreshes from `mcp.json` immediately and reports per-server status, tool
names, and errors. End-to-end check: add the `everything` server from the
example above, then ask Iris in chat to "use the mcp echo tool to echo
hello" — the tool event shows `mcp__everything__echo` and the reply round-trips
through the server. To test degradation, break the config (e.g. a bogus
`command`) and confirm the next message still works, with the failure listed
under "MCP Servers" in status.

## Security

- MCP servers run **on the host, as the iris user, outside the bash
  sandbox** — a stdio entry is arbitrary command execution. Only configure
  servers you trust, from sources you trust.
- Tool descriptions and results from remote servers are untrusted input and
  a prompt-injection surface. Prefer `allowedTools` to keep the exposed
  surface minimal.
- The `mcp` skill instructs Iris to check with the operator before adding
  new servers and to keep secrets in `.env`.

## Managing through chat

The `mcp` skill (in `skills/mcp/`) teaches Iris to add, remove, verify, and
narrow servers herself by editing `mcp.json` — the same
configure-through-chat idiom as `channels.json` and her self-written skills.
Ask her to "add the Linear MCP server" and she'll ask for the token, wire it
via `.env`, and verify the connection.

## Troubleshooting

- Logs: `journalctl -u iris | grep '\[mcp'` — connects, failures, stdio
  stderr, and dropped tools are all prefixed `[mcp:<server>]`.
- `npx` servers can hit `connectTimeoutMs` on their first (cold-download)
  run; raise the timeout or pre-warm with `npx -y <pkg> --help`.
- Slow MCP calls count against the whole-run LLM timeout
  (`IRIS_LLM_TIMEOUT_SECS`, default 90s) like any other tool call; keep
  `timeoutMs` comfortably below it.
