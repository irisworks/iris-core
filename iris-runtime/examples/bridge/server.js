/**
 * Iris Bridge Server — Reference Implementation
 *
 * Receives messages from an external channel and forwards them to
 * iris-runtime via its HTTP session API.
 *
 * Out of the box this implements:
 *   POST /webhook         — inbound messages from any source (API key protected)
 *   POST /webhook/echo    — inject human-agent replies into session history
 *   GET  /health          — liveness probe
 *
 * To add a polling channel (Telegram, Twitter, etc.), see the commented
 * section at the bottom of this file.
 *
 * Environment variables:
 *   IRIS_BRIDGE_URL   — iris-runtime base URL  (default: http://iris-agent:3000)
 *   BRIDGE_PORT       — port to listen on       (default: 4300)
 *   BRIDGE_API_KEY    — shared secret for inbound webhook auth
 */

import http from "http";

const PORT            = parseInt(process.env.BRIDGE_PORT    || "4300");
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY          || "";
const IRIS_BRIDGE_URL = process.env.IRIS_BRIDGE_URL         || "http://iris-agent:3000";

if (!BRIDGE_API_KEY) {
  console.error("[bridge] BRIDGE_API_KEY not set — all webhook requests will be rejected");
  process.exit(1);
}

function log(source, msg) {
  console.log(`[${new Date().toISOString()}] [${source}] ${msg}`);
}

// ── Session registry ──────────────────────────────────────
// Maps senderId → sessionId (in-memory; iris-runtime persists sessions on disk).
// On bridge restart, the map is empty but sessions are recovered lazily on
// the next message from each sender via getOrCreateSession.
const activeSessions = new Map();

async function getOrCreateSession(senderId, userName) {
  if (activeSessions.has(senderId)) return activeSessions.get(senderId);

  const resp = await irisRequest("POST", "/sessions", {
    originChannel: senderId,
    originThreadTs: "1",
    metadata: { userName, platform: "webhook" },
  });

  if (!resp.sessionId) throw new Error(`Failed to create session: ${JSON.stringify(resp)}`);
  activeSessions.set(senderId, resp.sessionId);
  log("bridge", `New session ${resp.sessionId} for ${senderId} (${userName})`);
  return resp.sessionId;
}

async function sendToIris(senderId, userName, text) {
  const sessionId = await getOrCreateSession(senderId, userName);
  const resp = await irisRequest("POST", `/sessions/${sessionId}/message`, { user: senderId, userName, text });

  // Session expired — clear and retry once
  if (resp._status === 404) {
    activeSessions.delete(senderId);
    const newId = await getOrCreateSession(senderId, userName);
    return irisRequest("POST", `/sessions/${newId}/message`, { user: senderId, userName, text });
  }

  return resp;
}

// ── iris-runtime HTTP client ──────────────────────────────
function irisRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(IRIS_BRIDGE_URL + path);
    const data = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          parsed._status = res.statusCode;
          resolve(parsed);
        } catch {
          resolve({ _status: res.statusCode, raw });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── HTTP server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Liveness probe
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200); res.end("ok"); return;
  }

  // ── Echo endpoint — inject human-agent replies into session history ──
  // Call this when a human operator replies on behalf of the bot so that
  // iris-runtime's conversation history stays accurate.
  // Does NOT trigger the LLM.
  if (req.method === "POST" && req.url === "/webhook/echo") {
    if (!checkAuth(req, res)) return;

    const body = await readBody(req, res); if (!body) return;
    const { sender_id, text } = body;

    if (!sender_id || !text) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sender_id and text required" }));
      return;
    }

    try {
      const sessionId = await getOrCreateSession(sender_id, "user");
      await irisRequest("POST", `/sessions/${sessionId}/inject-turn`, {
        role: "assistant", text, user: "human-agent",
      });
      log("echo", `[${sender_id}] injected into session ${sessionId}`);
      res.writeHead(200); res.end(JSON.stringify({ status: "ok", sessionId }));
    } catch (err) {
      log("echo", `Error: ${err.message}`);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Main webhook — forward inbound message to iris-runtime ────────────
  if (req.method === "POST" && req.url === "/webhook") {
    if (!checkAuth(req, res)) return;

    const body = await readBody(req, res); if (!body) return;

    // Expected payload: { sender_id, user_name, text }
    // Adapt parsePayload() below for your channel's specific format.
    const { senderId, userName, text } = parsePayload(body);

    if (!senderId || !text) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sender_id and text are required" }));
      return;
    }

    log("webhook", `[${senderId}] ${userName}: ${text.slice(0, 80)}`);

    // /clear — wipe conversation context
    if (text.trim() === "/clear") {
      try {
        const sessionId = activeSessions.get(senderId);
        if (sessionId) await irisRequest("POST", `/sessions/${sessionId}/reset`, {});
        activeSessions.delete(senderId);
        log("webhook", `[${senderId}] context cleared`);
      } catch (e) {
        log("webhook", `[${senderId}] /clear failed: ${e.message}`);
      }
      res.writeHead(200); res.end(JSON.stringify({ response: "Starting fresh." }));
      return;
    }

    try {
      const resp  = await sendToIris(senderId, userName, text);
      const reply = resp.text || resp.response || "";
      log("webhook", `[${senderId}] reply: ${reply.slice(0, 80)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: reply }));
    } catch (err) {
      log("webhook", `Error: ${err.message}`);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => log("server", `Bridge listening on :${PORT}`));

// ── Helpers ───────────────────────────────────────────────

function checkAuth(req, res) {
  const key = req.headers["x-api-key"] || "";
  if (key !== BRIDGE_API_KEY) {
    log("auth", `Unauthorized from ${req.socket.remoteAddress}`);
    res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

function readBody(req, res) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: "invalid json" })); resolve(null); }
    });
  });
}

/**
 * parsePayload — adapt this for your channel's message format.
 *
 * Expected input:  { sender_id, user_name, text, ... }
 * Expected output: { senderId, userName, text }
 *
 * Add a platform prefix to senderId to keep namespaces separate when
 * you support multiple channels (e.g. "tg_12345", "ig_67890", "sms_+1...").
 */
function parsePayload(body) {
  return {
    senderId: String(body.sender_id || ""),
    userName: String(body.user_name || body.sender_id || "user"),
    text:     String(body.text      || body.message   || ""),
  };
}

// ── Polling channel (optional) ────────────────────────────
// If your external channel requires polling rather than receiving webhooks
// (e.g. Telegram getUpdates, a REST queue), add a polling loop here.
//
// Pattern:
//
// let offset = 0;
//
// async function poll() {
//   try {
//     const updates = await fetchUpdates(offset);   // your channel SDK
//     for (const update of updates) {
//       offset = update.id + 1;
//       const { senderId, userName, text } = parseUpdate(update);
//       const resp = await sendToIris(senderId, userName, text);
//       await sendReply(update.chatId, resp.text || resp.response || "");
//     }
//   } catch (err) {
//     log("poll", `Error: ${err.message}`);
//   }
// }
//
// async function startPolling() {
//   log("poll", "Starting polling loop");
//   while (true) {
//     await poll();
//     await new Promise(r => setTimeout(r, 500));
//   }
// }
//
// startPolling();
