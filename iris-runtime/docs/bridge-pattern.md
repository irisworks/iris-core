# Bridge Pattern — Non-Slack Agent Ingress

The bridge pattern lets an iris-runtime agent receive messages from any external
channel — Instagram DMs, Telegram, SMS, a custom webhook, a polling API — without
modifying iris-runtime itself.

## Architecture

```
External channel
  (webhook / polling)
        │
        ▼
┌───────────────┐        HTTP session API         ┌─────────────────────┐
│  bridge       │ ──── POST /sessions/:id/message ─▶│  iris-runtime       │
│  (Docker)     │ ◀─── { text, response }  ────────│  (Docker, headless) │
└───────────────┘                                  └─────────────────────┘
        │                                                    │
        └──────────── iris-internal Docker network ──────────┘
```

Both containers run on the same Docker network (`iris-internal`).
The bridge reaches iris-runtime at `http://iris-<agent>:3000`.

## When to Use the Bridge Pattern

Use it when:
- The ingress channel is not Slack (Telegram, WhatsApp, SMS, email, REST webhook)
- You need to multiplex multiple external channels into one iris-runtime instance
- You want custom auth, payload parsing, or deduplication before hitting the LLM
- You need to inject human-agent messages into the conversation history without
  triggering the LLM (use `/sessions/:id/inject-turn`)

Stick with the standard Slack pattern when:
- Your agent only needs to respond to Slack messages
- You don't need custom webhook handling

## iris-runtime HTTP Session API

When iris-runtime starts without Slack tokens, it exposes an HTTP API on port 3000.

### Create a session
```http
POST /sessions
Content-Type: application/json

{
  "originChannel": "<stable-sender-id>",
  "originThreadTs": "1",
  "metadata": { "userName": "Alice", "platform": "telegram" }
}

→ { "sessionId": "abc123" }
```

### Send a message (triggers LLM)
```http
POST /sessions/:id/message
Content-Type: application/json

{ "user": "<sender-id>", "userName": "Alice", "text": "Hello!" }

→ { "text": "Hi Alice! How can I help?" }
```

### Inject a turn without triggering LLM
Use this to record a human agent's reply into the conversation history:
```http
POST /sessions/:id/inject-turn
Content-Type: application/json

{ "role": "assistant", "text": "A human agent replied here.", "user": "human-agent" }
```

### Reset session context
Wipes the conversation history so the next message starts fresh:
```http
POST /sessions/:id/reset
```

## Session Persistence

Each unique sender should get a stable, persistent session derived from their
sender ID (e.g. `tg_12345678` for Telegram user 12345678). iris-runtime persists
the session context on disk at `/workspace/sessions/`. Sessions survive restarts.

Pattern used in the reference bridge:
```js
// Map sender ID → session ID (in-memory; repopulated from disk on restart)
const activeSessions = new Map();

async function getOrCreateSession(senderId, userName) {
  if (activeSessions.has(senderId)) return activeSessions.get(senderId);
  const resp = await irisPost("/sessions", { originChannel: senderId, originThreadTs: "1" });
  activeSessions.set(senderId, resp.sessionId);
  return resp.sessionId;
}
```

## Docker Setup

### bridge `bootstrap.sh` additions
```bash
# iris-runtime runs headless — no Slack tokens
docker run -d --name iris-myagent \
  --network iris-internal \
  ...                              # no IRIS_SLACK_APP_TOKEN / BOT_TOKEN
  iris-runtime:local --sandbox=host /workspace

# Bridge handles the external channel
docker run -d --name myagent-bridge \
  --network iris-internal \
  --restart unless-stopped \
  -p 127.0.0.1:4300:4300 \
  -e BRIDGE_PORT=4300 \
  -e BRIDGE_API_KEY="$BRIDGE_API_KEY" \
  -e IRIS_BRIDGE_URL="http://iris-myagent:3000" \
  myagent-bridge:local
```

### Expose the bridge via nginx (optional)
If the bridge needs to receive inbound webhooks from the internet:
```nginx
server {
    listen 443 ssl;
    server_name myagent.example.com;

    location /webhook {
        proxy_pass http://127.0.0.1:4300;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Security Model

- The bridge container has **no filesystem mounts** — only env vars
- iris-runtime is **not exposed** to the internet — only reachable inside `iris-internal`
- Inbound webhook requests should require an `X-API-Key` header (see reference bridge)
- Store the API key in `/iris/.secrets.env` and load via `BRIDGE_API_KEY` env var

## Reference Implementation

See `iris-runtime/examples/bridge/` for a working Node.js bridge that demonstrates:
- Inbound HTTP webhook endpoint with API key auth
- Session creation and persistence per sender
- `POST /sessions/:id/message` for LLM-triggered responses
- `POST /sessions/:id/inject-turn` for human-agent echo injection
- `POST /sessions/:id/reset` for `/clear` commands
- Commented section showing how to add a polling channel (e.g. Telegram)

Copy the `examples/bridge/` directory into your agent folder and extend it for
your specific channel.
