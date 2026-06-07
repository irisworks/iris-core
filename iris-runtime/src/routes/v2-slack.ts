/**
 * /v2/slack — inbound route for Gateway-forwarded Slack messages.
 *
 * POST /v2/slack/inbound
 *   Called by the API Gateway when GATEWAY_MODE=true (replaces Socket Mode).
 *   body: {
 *     workspaceId: string   — Slack team_id (e.g. "T01234567")
 *     channelId:   string   — Slack channel ID (e.g. "C01234567")
 *     text:        string   — message text
 *     user?:       string   — Slack user ID
 *     ts?:         string   — Slack message timestamp
 *     threadTs?:   string   — thread root ts (for thread replies)
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

export const handleV2Slack: V2Handler = async (method, parts, _req, readBody, deps) => {
  // POST /v2/slack/inbound
  if (method === "POST" && parts[0] === "inbound") {
    let body: {
      workspaceId?: string;
      channelId?:   string;
      text?:        string;
      user?:        string;
      ts?:          string;
      threadTs?:    string;
    };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.workspaceId || !body.channelId || !body.text)
      return err(400, "workspaceId, channelId, and text are required");

    if (GATEWAY_MODE && deps.jwtContext && !isIntegrationScoped(deps.jwtContext)) {
      log.logWarning(`[v2/slack/inbound] Rejected Internal JWT with non-integration scope "${deps.jwtContext.scope}"`);
      return err(403, "Internal JWT is not scoped for Slack integration traffic");
    }

    if (!deps.slackLinkManager)
      return err(503, "Slack not configured on this runtime");

    // Resolve the linked agent for this workspace
    const linkedInfo = await deps.slackLinkManager.getLinkedAgent(body.workspaceId);
    if (!linkedInfo) {
      // Unlinked workspace — only accept claim tokens
      const isClaimToken = /^[0-9a-f]{64}$/.test(body.text.trim());
      if (!isClaimToken)
        return err(404, "No agent linked to this workspace. Send a claim token to link one.");

      try {
        await deps.slackLinkManager.validateAndLink(body.workspaceId, body.text.trim());
        return ok({ response: "Workspace linked successfully to agent." });
      } catch (e) {
        return err(400, `Token validation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const agent = await getSubAgent(linkedInfo.agentId);
    if (!agent) return err(404, "Linked agent not found");
    if (agent.status !== "running") return err(503, `Agent is ${agent.status}`);

    const channelId = body.channelId;
    const bridgeUrl = agentBridgeUrl(agent.slotIndex, agent.runtime);

    log.logInfo(`[v2/slack/inbound] workspace=${body.workspaceId} channel=${channelId} agent=${agent.name}`);

    try {
      const resp = await fetch(`${bridgeUrl}/bridge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...runtimeAuthHeader(agent.agentId, agent.runtime) },
        body:    JSON.stringify({
          channelId,
          text: body.text,
          user: body.user ?? "slack-user",
        }),
        signal: AbortSignal.timeout(120_000),
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
