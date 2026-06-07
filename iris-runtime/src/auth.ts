/**
 * JWT utilities for Gateway integration.
 *
 * GATEWAY_MODE=false (default) → all auth is a passthrough; existing behaviour preserved.
 * GATEWAY_MODE=true            → /v2/* routes require a valid Internal JWT from the Gateway.
 *
 * Internal JWT (issued by API Gateway):
 *   { userId, vmId, runtimeId, agentId?, runtimeType }
 *
 * Runtime JWT (issued by iris-runtime for internal sub-calls):
 *   { agentId, runtimeId, runtimeType, scope: "runtime" }
 *
 * Uses HS256 via Node.js built-in `crypto` — no additional dependencies.
 */

import { createHmac, timingSafeEqual } from "crypto";
import * as log from "./log.js";

export const GATEWAY_MODE = process.env.GATEWAY_MODE === "true";

const GATEWAY_JWT_SECRET  = process.env.GATEWAY_JWT_SECRET  ?? "";
const RUNTIME_JWT_SECRET  = process.env.RUNTIME_JWT_SECRET  ?? "";

export const RUNTIME_ID   = process.env.IRIS_RUNTIME_ID ?? "default";
export const VM_ID        = process.env.IRIS_VM_ID      ?? "default";

// ── Payload shapes ──────────────────────────────────────────────────────────

export interface InternalJWTPayload {
  userId:      string;
  vmId:        string;
  runtimeId:   string;
  agentId?:    string;
  runtimeType: "HOST_VM" | "DOCKER";
  /**
   * Set to "integration" when the Gateway mints this token specifically to
   * forward Telegram/Slack bot traffic (the architecture's third JWT tier,
   * the "bot <-> Gateway" boundary). Absent on generic Internal JWTs used for
   * management traffic (sub-agent admin, main-agent calls, etc).
   */
  scope?:      "integration";
  iat?:        number;
  exp?:        number;
}

export interface RuntimeJWTPayload {
  agentId:     string;
  runtimeId:   string;
  runtimeType: "HOST_VM" | "DOCKER";
  scope:       "runtime";
  iat?:        number;
  exp?:        number;
}

// ── HS256 helpers ───────────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  const b64 = Buffer.isBuffer(input)
    ? input.toString("base64")
    : Buffer.from(input, "utf-8").toString("base64");
  return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function hmacSig(header: string, body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
}

function jwtEncode(payload: object, secret: string, ttlSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now    = Math.floor(Date.now() / 1000);
  const body   = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${header}.${body}.${hmacSig(header, body, secret)}`;
}

function jwtDecode<T extends object>(token: string, secret: string): T | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  const expected = hmacSig(header, body, secret);
  try {
    const a = Buffer.from(sig,      "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64").toString("utf-8")) as T & { exp?: number };
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function validateInternalJWT(token: string): InternalJWTPayload | null {
  return jwtDecode<InternalJWTPayload>(token, GATEWAY_JWT_SECRET);
}

/**
 * Integration JWT — the architecture's "bot <-> Gateway" tier. The Gateway
 * forwards Telegram/Slack messages to iris-runtime via POST
 * /v2/telegram|slack/inbound and is expected to mint those Internal JWTs with
 * scope:"integration", distinguishing bot-relay traffic from generic
 * management traffic (sub-agent admin, main-agent calls, etc). Without this
 * check, a token minted for one purpose could be replayed to inject fake user
 * messages into a linked agent's conversation through the inbound routes.
 *
 * Tokens that omit the scope claim are treated as generic/legacy Internal
 * JWTs and still pass — this only rejects a token that explicitly claims a
 * *different* scope, so Gateways that don't yet mint scoped tokens keep
 * working unchanged (additive, same posture as RUNTIME_AUTH_ENABLED).
 */
export function isIntegrationScoped(payload: InternalJWTPayload): boolean {
  return !payload.scope || payload.scope === "integration";
}

export function generateRuntimeJWT(agentId: string, runtimeType: "HOST_VM" | "DOCKER"): string {
  return jwtEncode(
    { agentId, runtimeId: RUNTIME_ID, runtimeType, scope: "runtime" },
    RUNTIME_JWT_SECRET,
    300,
  );
}

export function validateRuntimeJWT(token: string): RuntimeJWTPayload | null {
  const payload = jwtDecode<RuntimeJWTPayload>(token, RUNTIME_JWT_SECRET);
  return payload && payload.scope === "runtime" ? payload : null;
}

/**
 * Runtime JWT signing/verification activates only once an operator sets
 * RUNTIME_JWT_SECRET — existing deployments that never configured it keep
 * working exactly as before (bridge calls unauthenticated, as today).
 */
export const RUNTIME_AUTH_ENABLED = RUNTIME_JWT_SECRET.length > 0;

export function runtimeTypeForAgent(runtime: "docker" | "firecracker"): "HOST_VM" | "DOCKER" {
  return runtime === "docker" ? "DOCKER" : "HOST_VM";
}

/**
 * Build the Authorization header iris-runtime attaches to internal sub-calls
 * (bridge requests into a sub-agent's runtime). Empty when RUNTIME_AUTH_ENABLED
 * is false, so unconfigured deployments see no behaviour change.
 */
export function runtimeAuthHeader(agentId: string, runtime: "docker" | "firecracker"): Record<string, string> {
  if (!RUNTIME_AUTH_ENABLED) return {};
  return { Authorization: `Bearer ${generateRuntimeJWT(agentId, runtimeTypeForAgent(runtime))}` };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * One-user-one-VM scoping: a Firecracker VM is dedicated to a single user, and
 * the Internal JWT carries the vmId/runtimeId the Gateway minted it for. Once
 * the Orchestrator has assigned this runtime a real identity (both IRIS_VM_ID
 * and IRIS_RUNTIME_ID configured — not the "default" placeholder), a validly
 * *signed* token that targets a different VM/runtime must still be rejected,
 * otherwise any runtime sharing GATEWAY_JWT_SECRET would accept any user's
 * token. Stays inert for unconfigured/standalone deployments — same as
 * RUNTIME_AUTH_ENABLED's gating on RUNTIME_JWT_SECRET — so existing behaviour
 * is preserved until the Gateway actually assigns per-VM identity.
 */
export const SCOPE_ENFORCED = VM_ID !== "default" && RUNTIME_ID !== "default";

/**
 * Resolve auth for a /v2/* request.
 *
 * Returns:
 *   InternalJWTPayload  — GATEWAY_MODE=true, token valid (and correctly scoped
 *                         to this VM/runtime, once SCOPE_ENFORCED is active)
 *   null                — GATEWAY_MODE=false (passthrough — no auth enforced)
 *   false               — GATEWAY_MODE=true, token missing, invalid, or scoped
 *                         to a different VM/runtime → reject with 401
 */
export function resolveGatewayAuth(
  authHeader: string | undefined,
): InternalJWTPayload | null | false {
  if (!GATEWAY_MODE) return null;
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  const payload = validateInternalJWT(token);
  if (!payload) return false;
  if (SCOPE_ENFORCED && (payload.vmId !== VM_ID || payload.runtimeId !== RUNTIME_ID)) {
    log.logWarning(
      `[auth] Rejected Internal JWT scoped to vm=${payload.vmId}/runtime=${payload.runtimeId} ` +
      `— this runtime is vm=${VM_ID}/runtime=${RUNTIME_ID}`,
    );
    return false;
  }
  return payload;
}
