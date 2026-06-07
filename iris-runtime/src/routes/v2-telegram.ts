/**
 * /v2/telegram — inbound route for Gateway-forwarded Telegram messages.
 *
 * POST /v2/telegram/inbound
 *   Called by the API Gateway instead of long-polling bots when GATEWAY_MODE=true.
 *   body: {
 *     botId:     string   — Telegram bot numeric ID
 *     chatId:    string   — Telegram chat numeric ID
 *     text:      string   — message text
 *     user?:     string   — display name or username
 *     messageId: number   — Telegram message_id (for dedup)
 *   }
 *   Returns: { ok, data: { response: string } }
 */

import * as log from "../log.js";
import { getSubAgent } from "../sub-agent-registry.js";
import { runtimeAuthHeader, GATEWAY_MODE, isIntegrationScoped } from "../auth.js";
import type { V2Handler } from "./v2-types.js";
import { ok, err } from "./v2-types.js";

function agentBridgeUrl(slotIndex: number, runtime: string): string {
  if (runtime === "firecracker") return `http://172.20.${slotIndex}.2:4200`;
  return `http://127.0.0.1:${4200 + slotIndex}`;
}

export const handleV2Telegram: V2Handler = async (method, parts, _req, readBody, deps) => {
  // POST /v2/telegram/inbound
  if (method === "POST" && parts[0] === "inbound") {
    let body: {
      botId?:     string;
      chatId?:    string;
      text?:      string;
      user?:      string;
      messageId?: number;
    };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.botId || !body.chatId || !body.text)
      return err(400, "botId, chatId, and text are required");

    if (GATEWAY_MODE && deps.jwtContext && !isIntegrationScoped(deps.jwtContext)) {
      log.logWarning(`[v2/telegram/inbound] Rejected Internal JWT with non-integration scope "${deps.jwtContext.scope}"`);
      return err(403, "Internal JWT is not scoped for Telegram integration traffic");
    }

    if (!deps.telegramLinkManager)
      return err(503, "Telegram not configured on this runtime");

    // Resolve the linked agent for this bot
    const linkedInfo = await deps.telegramLinkManager.getLinkedAgent(body.botId);
    if (!linkedInfo) {
      // Unlinked bot — only accept claim tokens
      const isClaimToken = /^[0-9a-f]{64}$/.test(body.text.trim());
      if (!isClaimToken)
        return err(404, "No agent linked to this bot. Send a claim token to link one.");

      try {
        await deps.telegramLinkManager.validateAndLink(body.botId, body.text.trim());
        return ok({ response: "Bot linked successfully to agent." });
      } catch (e) {
        return err(400, `Token validation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const agent = await getSubAgent(linkedInfo.agentId);
    if (!agent) return err(404, "Linked agent not found");
    if (agent.status !== "running") return err(503, `Agent is ${agent.status}`);

    const channelId = `tg-${body.chatId}`;
    const bridgeUrl = agentBridgeUrl(agent.slotIndex, agent.runtime);

    log.logInfo(`[v2/telegram/inbound] bot=${body.botId} chat=${body.chatId} agent=${agent.name}`);

    try {
      const resp = await fetch(`${bridgeUrl}/bridge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...runtimeAuthHeader(agent.agentId, agent.runtime) },
        body:    JSON.stringify({ channelId, text: body.text, user: body.user ?? body.chatId }),
        signal:  AbortSignal.timeout(120_000),
      });
      if (!resp.ok) throw new Error(`Bridge ${resp.status}`);
      const data = (await resp.json()) as { response?: string };
      return ok({ response: data.response ?? "" });
    } catch (e) {
      return err(504, `Bridge call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return null;
};
