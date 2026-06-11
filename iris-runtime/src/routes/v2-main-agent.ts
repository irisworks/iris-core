/**
 * /v2/main-agent — direct access to the primary Iris agent.
 *
 * POST /v2/main-agent/message
 *   body: { text: string, user?: string, sessionId?: string }
 *   → injects the message and waits for response
 *   → auto-creates a SESSION channel if no sessionId provided
 *
 * GET /v2/main-agent/history/:threadId
 *   → conversation history for a session or channel
 */

import * as log from "../log.js";
import { registerSessionRequest } from "../sessions.js";
import { randomBytes } from "crypto";
import type { V2Handler } from "./v2-types.js";
import { ok, err } from "./v2-types.js";

export const handleV2MainAgent: V2Handler = async (method, parts, _req, readBody, deps) => {
  // POST /v2/main-agent/message
  if (method === "POST" && parts[0] === "message" && parts.length === 1) {
    let body: { text?: string; user?: string; sessionId?: string };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.text) return err(400, "text is required");

    const bot = deps.getBot();
    if (!bot) return err(503, "Main agent not available (bot not started)");

    // Use provided sessionId or auto-generate a transient one.
    // No session-store lookup needed — injectSessionMessage reuses the in-memory
    // channel context for the given sessionId if it already exists.
    let sessionId = body.sessionId ?? randomBytes(8).toString("hex");

    log.logInfo(`[v2/main-agent/message] session=${sessionId}: ${body.text.substring(0, 60)}`);
    try {
      const response = await bot.injectSessionMessage(sessionId, body.user ?? "gateway", body.text);
      return ok({ response, sessionId });
    } catch (e) {
      return err(504, e instanceof Error ? e.message : String(e));
    }
  }

  // GET /v2/main-agent/history/:threadId
  if (method === "GET" && parts[0] === "history" && parts[1]) {
    const threadId = parts[1];
    const history  = threadId.startsWith("SESSION-")
      ? deps.threadManager.getSessionHistory(deps.workingDir, threadId.slice("SESSION-".length))
      : deps.threadManager.getHistory(threadId);
    return ok({ threadId, history });
  }

  return null;
};
