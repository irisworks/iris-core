/**
 * /v2/health  — liveness + readiness for the VM Orchestrator.
 *
 * GET  /v2/health           → { ok, status, channels, uptime }
 * GET  /v2/status           → full runtime state (channels, agents, integrations)
 * POST /v2/shutdown         → graceful shutdown (VM Orchestrator calls this before snapshot)
 */

import * as log from "../log.js";
import { listSubAgents } from "../sub-agent-registry.js";
import { RUNTIME_ID, VM_ID } from "../auth.js";
import { BLOB_ENABLED } from "../blob.js";
import { GATEWAY_MODE } from "../auth.js";
import type { V2Handler, V2Response } from "./v2-types.js";
import { ok, err } from "./v2-types.js";

const startedAt = Date.now();

export const handleV2Health: V2Handler = async (method, parts, _req, _readBody, deps) => {
  // GET /v2/health
  if (method === "GET" && parts.length === 0) {
    return ok({
      runtimeId:    RUNTIME_ID,
      vmId:         VM_ID,
      gatewayMode:  GATEWAY_MODE,
      blobEnabled:  BLOB_ENABLED,
      channels:     deps.channelStates.size,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  // GET /v2/status
  if (method === "GET" && parts[0] === "status") {
    const agents = await listSubAgents();
    const channels = Array.from(deps.channelStates.entries()).map(([id, s]) => ({
      id,
      running: s.running,
    }));
    return ok({
      runtimeId:    RUNTIME_ID,
      vmId:         VM_ID,
      gatewayMode:  GATEWAY_MODE,
      blobEnabled:  BLOB_ENABLED,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      channels,
      agents: agents.map(a => ({
        agentId:   a.agentId,
        name:      a.name,
        runtime:   a.runtime,
        status:    a.status,
        slotIndex: a.slotIndex,
      })),
    });
  }

  // POST /v2/shutdown
  if (method === "POST" && parts[0] === "shutdown") {
    log.logInfo("[v2/shutdown] Graceful shutdown requested by Orchestrator");
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
    return ok({ message: "Shutdown initiated" });
  }

  return null;
};
