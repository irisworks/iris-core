/**
 * /v2/sub-agents — full sub-agent lifecycle for Gateway consumption.
 *
 * GET    /v2/sub-agents                         list all
 * POST   /v2/sub-agents                         create
 * GET    /v2/sub-agents/:id                     get one
 * DELETE /v2/sub-agents/:id                     delete
 * PATCH  /v2/sub-agents/:id/skills              update skills
 * POST   /v2/sub-agents/:id/message             send message via bridge
 * GET    /v2/sub-agents/:id/history             conversation history (requires ?channelId=)
 * GET    /v2/sub-agents/:id/sessions            list sessions (threads) for this agent
 * POST   /v2/sub-agents/:id/integrations/:platform    attach dedicated bot/app credentials
 *                                                       (platform: telegram | slack) — returns claim token
 * DELETE /v2/sub-agents/:id/integrations/:platform    detach (deletes Key Vault secrets, re-provisions)
 *
 * Each sub-agent owns its own dedicated Telegram Bot / Slack App — there is no
 * shared pool to claim from. Attach stores the BYO credentials, re-provisions
 * the agent's container so the token becomes a live env var, and issues a claim
 * token; the owner sends that token to *their own* bot to prove control of it
 * (verified via POST /internal/integrations/:platform/verify, called back by the
 * bot's own runtime — see managers/integration.ts).
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "../log.js";
import {
  listSubAgents,
  getSubAgent,
  createSubAgent,
  deleteSubAgent,
  updateSubAgentStatus,
  type SubAgentRecord,
  type IntegrationKind,
} from "../sub-agent-registry.js";
import {
  provisionAgent,
  deprovisionAgent,
  deprovisionFirecrackerAgent,
  registerAgentBridge,
  unregisterAgentBridge,
  buildMemoryContentForAgent,
  getAvailableSkills,
  addSkillToAgent,
  removeSkillFromAgent,
} from "../agent-provision.js";
import { getDb } from "../db.js";
import { getSecret } from "../keyvault.js";
import { generateRuntimeJWT, runtimeAuthHeader, runtimeTypeForAgent } from "../auth.js";
import type { V2Handler } from "./v2-types.js";
import { ok, created, err } from "./v2-types.js";

const IRISDIR = process.env.IRIS_DIR ?? "/iris";

function agentBridgeUrl(slotIndex: number, runtime: string): string {
  if (runtime === "firecracker") return `http://172.20.${slotIndex}.2:4200`;
  return `http://127.0.0.1:${4200 + slotIndex}`;
}

/**
 * Re-provision an agent's container with its current set of dedicated-bot
 * credentials resolved from Key Vault. provisionDockerAgent does `docker rm -f`
 * before `docker run`, so calling this is effectively "restart with new env" —
 * the only way to apply env-var changes, since Docker has no live-injection.
 * Used after attach/detach so the running bot reflects the latest credentials.
 */
async function reprovisionWithCurrentIntegrations(agent: SubAgentRecord, workingDir: string): Promise<void> {
  const [telegramBotToken, slackAppToken, slackBotToken] = await Promise.all([
    getSecret(agent.telegramBotTokenRef),
    getSecret(agent.slackAppTokenRef),
    getSecret(agent.slackBotTokenRef),
  ]);
  const containerName = await provisionAgent({
    agentId:   agent.agentId,
    agentName: agent.name,
    slotIndex: agent.slotIndex,
    skills:    agent.skills,
    runtime:   agent.runtime,
    telegramBotToken: telegramBotToken ?? undefined,
    slackAppToken:    slackAppToken    ?? undefined,
    slackBotToken:    slackBotToken    ?? undefined,
  });
  await updateSubAgentStatus(agent.agentId, "running", containerName);
  registerAgentBridge(workingDir, agent.name, agent.agentId, agent.slotIndex, agent.runtime);
}

async function callBridge(
  bridgeUrl: string,
  channelId: string,
  text: string,
  user: string,
  agentId: string,
  runtime: "docker" | "firecracker",
): Promise<string> {
  const resp = await fetch(`${bridgeUrl}/bridge`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...runtimeAuthHeader(agentId, runtime) },
    body:    JSON.stringify({ channelId, text, user }),
    signal:  AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`Bridge responded ${resp.status}`);
  const data = (await resp.json()) as { text?: string; response?: string };
  return data.text ?? data.response ?? "";
}

export const handleV2SubAgents: V2Handler = async (method, parts, _req, readBody, deps) => {
  // GET /v2/sub-agents
  if (method === "GET" && parts.length === 0) {
    const agents = await listSubAgents();
    return ok({ agents });
  }

  // POST /v2/sub-agents
  if (method === "POST" && parts.length === 0) {
    let body: { name?: string; skills?: string[]; runtime?: "docker" | "firecracker" };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.name) return err(400, "name is required");
    if (!/^[a-zA-Z0-9-]{1,32}$/.test(body.name))
      return err(400, "name must be letters, numbers, hyphens (max 32 chars)");

    const runtime = body.runtime === "firecracker" ? "firecracker" : "docker";
    const record  = await createSubAgent({ name: body.name, skills: body.skills ?? [], runtime });
    if (!record) return err(409, `Agent "${body.name}" already exists or no slots available`);

    try {
      const containerName = await provisionAgent({
        agentId:   record.agentId,
        agentName: record.name,
        slotIndex: record.slotIndex,
        skills:    record.skills,
        runtime:   record.runtime,
      });
      await updateSubAgentStatus(record.agentId, "running", containerName);
      registerAgentBridge(deps.workingDir, record.name, record.agentId, record.slotIndex, record.runtime);
      log.logInfo(`[v2/sub-agents] created "${record.name}" slot=${record.slotIndex} ${record.runtime}`);
      const runtimeJwt = generateRuntimeJWT(record.agentId, runtimeTypeForAgent(record.runtime));
      return created({ ...record, status: "running", containerId: containerName, runtimeJwt });
    } catch (e) {
      await deleteSubAgent(record.agentId);
      return err(500, `Runtime failed to start: ${String(e)}`);
    }
  }

  // All remaining routes require :id
  const id = parts[0];
  if (!id) return null;

  // GET /v2/sub-agents/:id
  if (method === "GET" && parts.length === 1) {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    const integrations = await deps.integrationManager.getStatus(agent.agentId);
    return ok({ ...agent, integrations });
  }

  // DELETE /v2/sub-agents/:id
  if (method === "DELETE" && parts.length === 1) {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    // Key Vault cleanup for any attached credentials happens inside deleteSubAgent —
    // no separate unlink step needed (the container is being destroyed anyway).

    if (agent.runtime === "firecracker") {
      await deprovisionFirecrackerAgent(agent.slotIndex);
    } else {
      await deprovisionAgent(agent.dockerContainerId ?? `iris-agent-${agent.agentId}`);
    }
    unregisterAgentBridge(deps.workingDir, agent.name);
    const deleted = await deleteSubAgent(agent.agentId);
    log.logInfo(`[v2/sub-agents] deleted ${agent.agentId}`);
    return ok({ agentId: agent.agentId, deleted });
  }

  // PATCH /v2/sub-agents/:id/skills
  if (method === "PATCH" && parts[1] === "skills") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    let body: { add?: string[]; remove?: string[] };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }

    const invalid = deps.skillManager.validate([...(body.add ?? []), ...(body.remove ?? [])]);
    if (invalid.length) return err(400, `Unknown skills: ${invalid.join(", ")}`);

    let skills = [...agent.skills];
    if (body.add)    skills = [...new Set([...skills, ...body.add])];
    if (body.remove) skills = skills.filter(s => !(body.remove ?? []).includes(s));

    const db = getDb();
    if (db) await db.from("sub_agents").update({ skills, updated_at: new Date().toISOString() }).eq("agent_id", agent.agentId);

    const agentDir = `${IRISDIR}/data/agents/${agent.agentId}`;
    const skillsDir = process.env.IRIS_SKILLS_DIR ?? `${IRISDIR}/data/skills`;
    for (const s of (body.add ?? [])) {
      try { await addSkillToAgent(agentDir, s, skillsDir); } catch (e) {
        log.logWarning(`[v2/sub-agents] addSkill ${s}`, String(e));
      }
    }
    for (const s of (body.remove ?? [])) {
      try { removeSkillFromAgent(agentDir, s); } catch (e) {
        log.logWarning(`[v2/sub-agents] removeSkill ${s}`, String(e));
      }
    }

    writeFileSync(join(agentDir, "MEMORY.md"), buildMemoryContentForAgent(agent.name, skills, agent.runtime));

    log.logInfo(`[v2/sub-agents] skills updated for ${agent.agentId}: ${skills.join(", ")}`);
    return ok({ agentId: agent.agentId, skills });
  }

  // POST /v2/sub-agents/:id/message
  if (method === "POST" && parts[1] === "message") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    if (agent.status !== "running") return err(503, `Agent is ${agent.status}`);

    let body: { text?: string; user?: string; channelId?: string; newThread?: boolean };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.text) return err(400, "text is required");

    // Channel resolution — three cases:
    //   explicit channelId: use as-is (continue existing thread)
    //   newThread: true:    start a fresh thread with a random channelId
    //   neither:            fall back to per-agent default (single channel, backward-compat)
    let channelId: string;
    let isNewThread = false;
    if (body.channelId) {
      channelId = body.channelId;
    } else if (body.newThread) {
      channelId = `v2-${randomBytes(8).toString("hex")}`;
      isNewThread = true;
    } else {
      channelId = `v2-${agent.agentId}`;
    }

    // Create a session record for new threads so they appear in GET /sessions
    if (isNewThread) {
      deps.sessionManager.create({
        agentId:        agent.agentId,
        originChannel:  channelId,
        originThreadTs: Date.now().toString(),
        metadata:       { source: "v2-api", user: body.user ?? "gateway" },
      });
    }

    const bridgeUrl = agentBridgeUrl(agent.slotIndex, agent.runtime);
    log.logInfo(`[v2/sub-agents/${agent.agentId}/message] channel=${channelId}: ${body.text.substring(0, 60)}`);
    try {
      const response = await callBridge(bridgeUrl, channelId, body.text, body.user ?? "gateway", agent.agentId, agent.runtime);
      return ok({ response, agentId: agent.agentId, channelId, newThread: isNewThread });
    } catch (e) {
      return err(504, `Bridge call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // GET /v2/sub-agents/:id/sessions
  if (method === "GET" && parts[1] === "sessions") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    const sessions = deps.sessionManager.listForAgent(agent.agentId);
    return ok({ agentId: agent.agentId, sessions });
  }

  // POST /v2/sub-agents/:id/skills/define — create an agent-private skill
  // (not added to the global library; only visible in this agent's workspace)
  if (method === "POST" && parts[1] === "skills" && parts[2] === "define") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    let body: { name?: string; description?: string; content?: string };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.name || !body.description) return err(400, "name and description are required");
    const agentDir = `${IRISDIR}/data/agents/${agent.agentId}`;
    try {
      const skill = deps.skillManager.createForAgent(agentDir, body.name, body.description, body.content);
      log.logInfo(`[v2/sub-agents/${agent.agentId}/skills/define] created private skill "${body.name}"`);
      return created({ agentId: agent.agentId, skill });
    } catch (e) {
      return err(409, e instanceof Error ? e.message : String(e));
    }
  }

  // GET /v2/sub-agents/:id/history?channelId=...
  if (method === "GET" && parts[1] === "history") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    // Parse channelId from query string
    const rawUrl  = _req.url ?? "";
    const qStart  = rawUrl.indexOf("?");
    const params  = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : null;
    const channelId = params?.get("channelId");
    if (!channelId) return err(400, "channelId query parameter is required");

    const history = await deps.threadManager.getHistoryWithBlobFallback(agent.agentId, channelId);
    return ok({ agentId: agent.agentId, channelId, history });
  }

  // POST /v2/sub-agents/:id/integrations/:platform
  //   Manual path:  { telegramBotToken } | { slackAppToken, slackBotToken }
  //   Auto path:    { autoCreate: true, botName: "Research" }  (Telegram only)
  if (method === "POST" && parts[1] === "integrations" && parts[2]) {
    const platform = parts[2];
    if (platform !== "telegram" && platform !== "slack") return err(404, "Unknown platform");

    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    let body: {
      telegramBotToken?: string;
      slackAppToken?: string;
      slackBotToken?: string;
      autoCreate?: boolean;
      botName?: string;
    };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }

    // Auto-create path: BotFactory creates the bot with BotFather, then
    // the rest of the attach flow is identical to the manual path.
    if (platform === "telegram" && body.autoCreate) {
      if (!body.botName?.trim()) return err(400, "botName is required when autoCreate is true");
      try {
        const { createTelegramBot, BotFactoryUnavailableError } = await import("../bot-factory.js");
        const created = await createTelegramBot(body.botName.trim());
        body.telegramBotToken = created.botToken;
        log.logInfo(`[v2/sub-agents/${agent.agentId}/integrations/telegram] BotFactory created @${created.botUsername}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isUnavailable = e instanceof Error && e.name === "BotFactoryUnavailableError";
        const isRateLimited = /rate-limited|try again in|flood.*wait/i.test(msg);
        return err(
          isUnavailable ? 503 : isRateLimited ? 429 : 502,
          isRateLimited
            ? `Auto-create temporarily unavailable: ${msg}. Use "Paste bot token" to connect a bot created manually via @BotFather.`
            : `Bot creation failed: ${msg}`,
        );
      }
    }

    try {
      const result = await deps.integrationManager.attach(agent.agentId, platform as IntegrationKind, body);
      const refreshed = await getSubAgent(agent.agentId);
      if (refreshed) await reprovisionWithCurrentIntegrations(refreshed, deps.workingDir);
      log.logInfo(`[v2/sub-agents/${agent.agentId}/integrations/${platform}] credentials attached, claim token issued`);
      return ok({ agentId: agent.agentId, agentName: agent.name, platform, ...result });
    } catch (e) {
      return err(409, String(e));
    }
  }

  // DELETE /v2/sub-agents/:id/integrations/:platform
  if (method === "DELETE" && parts[1] === "integrations" && parts[2]) {
    const platform = parts[2];
    if (platform !== "telegram" && platform !== "slack") return err(404, "Unknown platform");

    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    const detached = await deps.integrationManager.detach(agent.agentId, platform as IntegrationKind);
    const refreshed = await getSubAgent(agent.agentId);
    if (refreshed) await reprovisionWithCurrentIntegrations(refreshed, deps.workingDir);
    log.logInfo(`[v2/sub-agents/${agent.agentId}/integrations/${platform}] detached=${detached}`);
    return ok({ agentId: agent.agentId, platform, detached });
  }

  return null;
};
