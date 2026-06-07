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
 * POST   /v2/sub-agents/:id/telegram/token      generate Telegram claim token
 * DELETE /v2/sub-agents/:id/telegram            unlink Telegram
 * POST   /v2/sub-agents/:id/slack/token         generate Slack claim token
 * DELETE /v2/sub-agents/:id/slack               unlink Slack
 */

import { writeFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import {
  listSubAgents,
  getSubAgent,
  createSubAgent,
  deleteSubAgent,
  updateSubAgentStatus,
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
import { generateRuntimeJWT, runtimeAuthHeader, runtimeTypeForAgent } from "../auth.js";
import type { V2Handler } from "./v2-types.js";
import { ok, created, err } from "./v2-types.js";

const IRISDIR = process.env.IRIS_DIR ?? "/iris";

function agentBridgeUrl(slotIndex: number, runtime: string): string {
  if (runtime === "firecracker") return `http://172.20.${slotIndex}.2:4200`;
  return `http://127.0.0.1:${4200 + slotIndex}`;
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
  const data = (await resp.json()) as { response?: string };
  return data.response ?? "";
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
    const links = await deps.integrationManager.getLinks(agent.agentId);
    return ok({ ...agent, integrations: links });
  }

  // DELETE /v2/sub-agents/:id
  if (method === "DELETE" && parts.length === 1) {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");

    await deps.integrationManager.unlink(agent.agentId, "telegram");
    await deps.integrationManager.unlink(agent.agentId, "slack");

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

    const links = await deps.integrationManager.getLinks(agent.agentId);
    deps.integrationManager.invalidateCache(links.telegram ?? "", links.slack ?? "");

    log.logInfo(`[v2/sub-agents] skills updated for ${agent.agentId}: ${skills.join(", ")}`);
    return ok({ agentId: agent.agentId, skills });
  }

  // POST /v2/sub-agents/:id/message
  if (method === "POST" && parts[1] === "message") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    if (agent.status !== "running") return err(503, `Agent is ${agent.status}`);

    let body: { text?: string; user?: string; channelId?: string };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.text) return err(400, "text is required");

    const channelId = body.channelId ?? `v2-${agent.agentId}`;
    const bridgeUrl = agentBridgeUrl(agent.slotIndex, agent.runtime);

    log.logInfo(`[v2/sub-agents/${agent.agentId}/message] channel=${channelId}: ${body.text.substring(0, 60)}`);
    try {
      const response = await callBridge(bridgeUrl, channelId, body.text, body.user ?? "gateway", agent.agentId, agent.runtime);
      return ok({ response, agentId: agent.agentId, channelId });
    } catch (e) {
      return err(504, `Bridge call failed: ${e instanceof Error ? e.message : String(e)}`);
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

  // POST /v2/sub-agents/:id/telegram/token
  if (method === "POST" && parts[1] === "telegram" && parts[2] === "token") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    try {
      const token = await deps.integrationManager.generateToken(agent.agentId, "telegram");
      log.logInfo(`[v2/sub-agents/${agent.agentId}/telegram/token] claim token issued`);
      return ok({
        token,
        agentName:        agent.name,
        expiresInSeconds: 600,
        instructions:     `Send this token to your Telegram bot to link it to "${agent.name}".`,
      });
    } catch (e) {
      return err(409, String(e));
    }
  }

  // DELETE /v2/sub-agents/:id/telegram
  if (method === "DELETE" && parts[1] === "telegram" && !parts[2]) {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    const unlinked = await deps.integrationManager.unlink(agent.agentId, "telegram");
    log.logInfo(`[v2/sub-agents/${agent.agentId}/telegram] unlinked=${unlinked}`);
    return ok({ agentId: agent.agentId, unlinked });
  }

  // POST /v2/sub-agents/:id/slack/token
  if (method === "POST" && parts[1] === "slack" && parts[2] === "token") {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    try {
      const token = await deps.integrationManager.generateToken(agent.agentId, "slack");
      log.logInfo(`[v2/sub-agents/${agent.agentId}/slack/token] claim token issued`);
      return ok({
        token,
        agentName:        agent.name,
        expiresInSeconds: 600,
        instructions:     `Send this token as a DM to your Slack bot to link it to "${agent.name}".`,
      });
    } catch (e) {
      return err(409, String(e));
    }
  }

  // DELETE /v2/sub-agents/:id/slack
  if (method === "DELETE" && parts[1] === "slack" && !parts[2]) {
    const agent = await getSubAgent(id);
    if (!agent) return err(404, "Agent not found");
    const unlinked = await deps.integrationManager.unlink(agent.agentId, "slack");
    log.logInfo(`[v2/sub-agents/${agent.agentId}/slack] unlinked=${unlinked}`);
    return ok({ agentId: agent.agentId, unlinked });
  }

  return null;
};
