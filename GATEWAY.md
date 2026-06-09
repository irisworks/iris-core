# Iris Runtime — Gateway & Orchestrator Contract

This document is for the developers building the **API Gateway** (Express) and
the **VM Orchestrator**. It describes exactly what iris-runtime exposes and
expects from each service so you can integrate without reading the full source.

---

## Table of Contents

1. [How JWT Auth Works](#how-jwt-auth-works)
2. [What iris-runtime Expects from the Gateway](#what-iris-runtime-expects-from-the-gateway)
3. [What iris-runtime Expects from the VM Orchestrator](#what-iris-runtime-expects-from-the-vm-orchestrator)
4. [Endpoints the Gateway Must Call](#endpoints-the-gateway-must-call)
5. [Adding a New Connector (e.g. WhatsApp, Discord)](#adding-a-new-connector)
6. [Routing Table](#routing-table)
7. [Error Response Format](#error-response-format)
8. [Environment Variables the Gateway/Orchestrator Must Set](#environment-variables)
9. [Local Testing Without Key Vault or Orchestrator](#local-testing)

---

## How JWT Auth Works

Three JWT tiers. Each is HS256 signed.

```
User JWT          issued by your auth service (e.g. Supabase Auth, Clerk)
    │
    ▼
API Gateway       validates User JWT, issues Internal JWT
    │
    ▼
iris-runtime      validates Internal JWT, issues Runtime JWT per sub-agent
    │
    ▼
Sub-Agent Bridge  validates Runtime JWT on every bridge request
```

### Internal JWT

Minted by the Gateway. Sent as `Authorization: Bearer <token>` on all `/v2/*`
requests to iris-runtime.

```json
{
  "userId":      "uuid — identifies the user making the request",
  "vmId":        "uuid — the VM this runtime lives on (from vm_routing)",
  "runtimeId":   "uuid — this specific runtime instance (from IRIS_RUNTIME_ID)",
  "agentId":     "uuid — target sub-agent (omit for main-agent or list calls)",
  "runtimeType": "HOST_VM | DOCKER | FIRECRACKER",
  "scope":       "integration (only for Telegram/Slack inbound routes; omit otherwise)",
  "iat":         1234567890,
  "exp":         1234571490
}
```

Shared secret: `GATEWAY_JWT_SECRET` (set identically on Gateway and iris-runtime).

### Runtime JWT

Minted by iris-runtime. Returned in `POST /v2/sub-agents` response as
`runtimeJwt`. The Gateway must attach it as `Authorization: Bearer <token>`
when calling that specific agent's bridge directly (if it ever does so).
iris-runtime also signs all its own internal bridge calls with this token.

```json
{
  "agentId":     "uuid",
  "runtimeId":   "uuid — matches IRIS_RUNTIME_ID on this iris-runtime",
  "runtimeType": "HOST_VM | DOCKER | FIRECRACKER",
  "scope":       "runtime",
  "iat":         1234567890,
  "exp":         1234571890
}
```

Shared secret: `RUNTIME_JWT_SECRET` (set on iris-runtime only; Gateway does not
need to validate Runtime JWTs — it receives Internal JWTs from the frontend,
not Runtime JWTs).

TTL: 5 minutes. The Gateway should cache and refresh.

### Integration JWT (Telegram / Slack inbound)

When relaying a message from a Telegram bot or Slack app, mint an Internal JWT
with `"scope": "integration"`. iris-runtime's `/v2/telegram/inbound` and
`/v2/slack/inbound` routes reject tokens with any other explicit scope value on
these two routes as an anti-replay guard (a management token can't be used to
inject fake bot messages).

```json
{
  "userId":      "uuid",
  "vmId":        "uuid",
  "runtimeId":   "uuid",
  "agentId":     "uuid — the linked agent",
  "runtimeType": "DOCKER",
  "scope":       "integration",
  "iat":         ...,
  "exp":         ...
}
```

---

## What iris-runtime Expects from the Gateway

1. **`GATEWAY_MODE=true`** env var set on startup — activates JWT enforcement
   on all `/v2/*` routes. Without it, all requests pass through unauthenticated.

2. Every `/v2/*` request carries `Authorization: Bearer <InternalJWT>`.

3. Telegram/Slack inbound requests carry an Integration-scoped JWT (see above).

4. The Gateway must **not** start its own Telegram/Slack long-polling for an
   agent when `GATEWAY_MODE=true` — iris-runtime's sub-agent containers also
   skip their own polling in that mode (both sides honour the same flag).

---

## What iris-runtime Expects from the VM Orchestrator

1. **`IRIS_VM_ID`** — the UUID of the VM this iris-runtime lives on. Must match
   the `vm_id` in the `vm_routing` row the Orchestrator created.

2. **`IRIS_RUNTIME_ID`** — the UUID of this runtime instance (can be the same
   as `IRIS_VM_ID` for a one-runtime-per-VM model, or distinct if you shard).

Once both are set to real UUIDs (not the default `"default"` placeholder):
- `runtime_mapping` rows are written on every `createSubAgent` call.
- One-user-one-VM scoping activates: a token minted for a different `vmId` is
  rejected even if the signature is valid.

The Orchestrator must create the `vm_routing` row **before** starting iris-runtime,
since `runtime_mapping` has a FK to `vm_routing(vm_id)`.

---

## Endpoints the Gateway Must Call

All responses use `{ "ok": true, "data": {...} }` on success or
`{ "ok": false, "error": "reason" }` on failure.

### Sub-agent lifecycle

```
POST   /v2/sub-agents                          Create agent, returns runtimeJwt
GET    /v2/sub-agents                          List all agents
GET    /v2/sub-agents/:id                      Get one agent + integration status
DELETE /v2/sub-agents/:id                      Delete (stops runtime, detaches all)
PATCH  /v2/sub-agents/:id/skills               { add?: [...], remove?: [...] }
```

### Messaging

```
POST   /v2/sub-agents/:id/message              { text, user?, channelId?, newThread? }
GET    /v2/sub-agents/:id/history?channelId=   Conversation history for a channel
GET    /v2/sub-agents/:id/sessions             All threads (sessions) for this agent
POST   /v2/main-agent/message                  { text, user?, sessionId? }
GET    /v2/main-agent/history/:threadId        History for a thread/channel
```

`newThread: true` generates a fresh `channelId`, creates a session record, and
returns `{ response, channelId, newThread: true }`. Pass `channelId` in
subsequent calls to continue the thread.

### Integration (Telegram / Slack attach)

```
POST   /v2/sub-agents/:id/integrations/telegram   { telegramBotToken }
POST   /v2/sub-agents/:id/integrations/slack       { slackAppToken, slackBotToken }
DELETE /v2/sub-agents/:id/integrations/telegram
DELETE /v2/sub-agents/:id/integrations/slack
```

Returns `{ claimToken, expiresInSeconds, status: "pending_verification" }`.
The Gateway surfaces this token to the user who then sends it to their bot.

### Integration inbound (bot → Gateway → here)

```
POST   /v2/telegram/inbound    { botId, chatId, text, user?, messageId? }
POST   /v2/slack/inbound       { workspaceId, channelId, text, user?, ts? }
```

Both require an Integration-scoped Internal JWT.

### Skills

```
GET    /v2/skills                   List global skill library
POST   /v2/skills                   { name, description, content? } — create skill
GET    /v2/skills/:name             Get skill detail
PATCH  /v2/skills/:name             { description?, content? } — update
DELETE /v2/skills/:name             Delete from global library
POST   /v2/sub-agents/:id/skills/define   { name, description, content? } — agent-private skill
```

### Runtime health

```
GET    /v2/health     { ok, runtimeId, vmId, gatewayMode, uptime, channels }
GET    /v2/status     Full state: agents, channels, uptime
POST   /v2/shutdown   Graceful shutdown (call before snapshotting the VM)
```

---

## Adding a New Connector

To add a connector beyond Telegram and Slack (e.g. WhatsApp, Discord):

### 1. Add a new inbound route in iris-runtime

Create `iris-runtime/src/routes/v2-whatsapp.ts` following the same pattern as
`v2-telegram.ts`:

```ts
// POST /v2/whatsapp/inbound
// Body: { phoneNumberId, from, text, user?, messageId? }
if (method === "POST" && parts[0] === "inbound") {
  if (deps.jwtContext && !isIntegrationScoped(deps.jwtContext)) {
    return err(403, "Internal JWT is not scoped for WhatsApp integration traffic");
  }
  // resolve agent by phoneNumberId, call bridge, return response
}
```

Register it in `v2-router.ts`:

```ts
if (path.startsWith("/v2/whatsapp/")) return handleV2WhatsApp(...);
```

### 2. Add a platform column to sub_agents (if storing credentials)

Add `whatsapp_phone_number_id_ref TEXT` and `whatsapp_status TEXT` to
`sub_agents` in `supabase/schema.sql` (same pattern as `telegram_bot_token_ref`).

Add the attach/detach endpoints:

```
POST   /v2/sub-agents/:id/integrations/whatsapp   { phoneNumberId, accessToken }
DELETE /v2/sub-agents/:id/integrations/whatsapp
```

Extend `IntegrationKind` in `sub-agent-registry.ts`:

```ts
export type IntegrationKind = "telegram" | "slack" | "whatsapp";
```

### 3. Gateway side

The Gateway receives the webhook from WhatsApp's servers, mints an
Integration-scoped Internal JWT (same as Telegram/Slack), and calls
`POST /v2/whatsapp/inbound`. No changes to iris-runtime's JWT logic needed.

---

## Routing Table

When `IRIS_VM_ID` is a real UUID, iris-runtime writes to `runtime_mapping` on
every `createSubAgent`. The Gateway reads this to resolve `agentId → vmIP`:

```sql
SELECT rm.bridge_url, vr.vm_ip, rm.runtime_type
FROM runtime_mapping rm
JOIN vm_routing vr ON rm.vm_id = vr.vm_id
WHERE rm.agent_id = '<agentId>';
```

| Column | Description |
|---|---|
| `agent_id` | UUID of the sub-agent |
| `vm_id` | UUID of the VM (FK to `vm_routing`) |
| `runtime_type` | `DOCKER`, `FIRECRACKER`, or `HOST_VM` |
| `bridge_url` | Direct bridge URL (e.g. `http://172.20.1.2:4200`) — for internal routing only, not exposed to clients |

The Gateway uses `vm_ip` from `vm_routing` to know which VM to send the
Internal JWT to. The `bridge_url` in `runtime_mapping` is the sub-agent's
internal bridge address within that VM — the Gateway proxies to `vmIP:3000`
(the iris-runtime API port), not directly to the bridge.

---

## Error Response Format

All `/v2/*` routes return:

```json
{ "ok": true,  "data": { ... } }          // 200 or 201
{ "ok": false, "error": "reason string" } // 400, 401, 403, 404, 409, 503, 504
```

Common status codes:

| Code | Meaning |
|---|---|
| 400 | Invalid request body or missing required field |
| 401 | `GATEWAY_MODE=true` and JWT missing, invalid, or expired |
| 403 | JWT valid but wrong scope (e.g. non-integration token on inbound routes) or wrong VM |
| 404 | Agent not found |
| 409 | Conflict (agent name taken, integration already linked) |
| 503 | Agent exists but is not running |
| 504 | Bridge call timed out (agent is running but did not respond within 120 s) |

---

## Environment Variables

The Gateway/Orchestrator must set these on each iris-runtime instance:

```bash
# Required for JWT enforcement
GATEWAY_MODE=true
GATEWAY_JWT_SECRET=<min 32 chars, shared with Gateway>
RUNTIME_JWT_SECRET=<min 32 chars, iris-runtime only>

# Required for one-user-one-VM scoping and routing table writes
IRIS_VM_ID=<uuid from vm_routing — injected by VM Orchestrator>
IRIS_RUNTIME_ID=<uuid of this runtime — injected by VM Orchestrator>
```

Do not set these until the Gateway and Orchestrator are actually deployed —
leaving them unset keeps iris-runtime in passthrough mode with no behaviour change.

---

## Local Testing

**Without Key Vault (`IRIS_KEY_VAULT` not set)**

Bot credential storage falls back to a `raw:<base64>` ref stored directly in
the `sub_agents` table. The attach flow works end-to-end; credentials are
recovered from the ref on container reprovision. This fallback logs a warning
and is **not suitable for production** (the token is recoverable from the DB).
Set `IRIS_KEY_VAULT` and configure `az` CLI before going live.

**Without VM Orchestrator (`IRIS_VM_ID` not set)**

`runtime_mapping` writes are skipped (they would fail the FK to `vm_routing`).
One-user-one-VM scoping is inactive. Everything else works normally.

**Without Gateway (`GATEWAY_MODE=false`)**

All `/v2/*` routes accept requests without any JWT. Use this for local
development; flip `GATEWAY_MODE=true` only once the Gateway is deployed.
