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

export function generateRuntimeJWT(agentId: string, runtimeType: "HOST_VM" | "DOCKER"): string {
  return jwtEncode(
    { agentId, runtimeId: RUNTIME_ID, runtimeType, scope: "runtime" },
    RUNTIME_JWT_SECRET,
    300,
  );
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * Resolve auth for a /v2/* request.
 *
 * Returns:
 *   InternalJWTPayload  — GATEWAY_MODE=true, token valid
 *   null                — GATEWAY_MODE=false (passthrough — no auth enforced)
 *   false               — GATEWAY_MODE=true, token missing or invalid → reject with 401
 */
export function resolveGatewayAuth(
  authHeader: string | undefined,
): InternalJWTPayload | null | false {
  if (!GATEWAY_MODE) return null;
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  return validateInternalJWT(token) ?? false;
}
