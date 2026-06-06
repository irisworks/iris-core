/**
 * v2-router — dispatches /v2/* requests to the correct handler.
 *
 * URL structure:  /v2/{resource}/{...parts}
 * Resource map:
 *   health       → v2-health.ts
 *   status       → v2-health.ts
 *   shutdown     → v2-health.ts
 *   main-agent   → v2-main-agent.ts
 *   sub-agents   → v2-sub-agents.ts
 *   telegram     → v2-telegram.ts
 *   slack        → v2-slack.ts
 *
 * Auth:
 *   GATEWAY_MODE=false → passthrough (no JWT required)
 *   GATEWAY_MODE=true  → Authorization: Bearer <InternalJWT> required on all /v2/* routes
 */

import { type IncomingMessage, type ServerResponse } from "http";
import { resolveGatewayAuth } from "../auth.js";
import * as log from "../log.js";
import { handleV2Health }      from "./v2-health.js";
import { handleV2MainAgent }   from "./v2-main-agent.js";
import { handleV2SubAgents }   from "./v2-sub-agents.js";
import { handleV2Telegram }    from "./v2-telegram.js";
import { handleV2Slack }       from "./v2-slack.js";
import type { V2Deps, V2Response } from "./v2-types.js";

function writeResponse(res: ServerResponse, result: V2Response): void {
  const payload = JSON.stringify(result.body);
  res.writeHead(result.status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached !== null) return cached;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data",  (c: Buffer) => chunks.push(c));
      req.on("end",   () => { cached = Buffer.concat(chunks).toString("utf-8"); resolve(cached); });
      req.on("error", reject);
    });
  };
}

/**
 * Attempt to handle a /v2/* request.
 * Returns true if handled (caller should not proceed to v1 routes).
 * Returns false if the URL is not a /v2/ path.
 */
export async function handleV2Request(
  method:  string,
  url:     string,
  req:     IncomingMessage,
  res:     ServerResponse,
  baseDeps: Omit<V2Deps, "jwtContext">,
): Promise<boolean> {
  if (!url.startsWith("/v2/") && url !== "/v2") return false;

  // Strip /v2/ prefix and split into parts
  const stripped = url.replace(/^\/v2\/?/, "").split("?")[0];
  const allParts = stripped ? stripped.split("/").map(decodeURIComponent) : [];
  const resource = allParts[0] ?? "";
  const parts    = allParts.slice(1);

  // ── Gateway auth ──────────────────────────────────────────────────────────
  const authResult = resolveGatewayAuth(req.headers.authorization);
  if (authResult === false) {
    writeResponse(res, { status: 401, body: { ok: false, error: "Invalid or missing Gateway JWT" } });
    return true;
  }

  const deps: V2Deps = { ...baseDeps, jwtContext: authResult };

  // ── Dispatch ──────────────────────────────────────────────────────────────
  const rb = readBody(req);

  let result: V2Response | null = null;

  try {
    if (resource === "health" || resource === "status" || resource === "shutdown") {
      result = await handleV2Health(method, [resource, ...parts], req, rb, deps);
    } else if (resource === "main-agent") {
      result = await handleV2MainAgent(method, parts, req, rb, deps);
    } else if (resource === "sub-agents") {
      result = await handleV2SubAgents(method, parts, req, rb, deps);
    } else if (resource === "telegram") {
      result = await handleV2Telegram(method, parts, req, rb, deps);
    } else if (resource === "slack") {
      result = await handleV2Slack(method, parts, req, rb, deps);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.logWarning(`[v2-router] unhandled error: ${method} /v2/${resource}`, msg);
    writeResponse(res, { status: 500, body: { ok: false, error: msg } });
    return true;
  }

  if (result) {
    writeResponse(res, result);
  } else {
    writeResponse(res, {
      status: 404,
      body:   { ok: false, error: `No v2 route matched: ${method} /v2/${[resource, ...parts].join("/")}` },
    });
  }
  return true;
}
