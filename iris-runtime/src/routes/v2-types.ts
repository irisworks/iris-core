/**
 * Shared types for all /v2/* route handlers.
 */

import type { IncomingMessage } from "http";
import type { InternalJWTPayload } from "../auth.js";
import type { TelegramLinkManager } from "../telegram-link.js";
import type { SlackLinkManager } from "../slack-link.js";
import type { SchedulerCallbacks } from "../scheduler.js";
import type { SessionManager } from "../managers/session.js";
import type { MemoryManager } from "../managers/memory.js";
import type { SkillManager } from "../managers/skill.js";
import type { ThreadManager } from "../managers/thread.js";
import type { IntegrationManager } from "../managers/integration.js";

export interface SessionInjector {
  injectSessionMessage(sessionId: string, user: string, text: string): Promise<string>;
  postMessage(channel: string, text: string): Promise<string>;
  resetSessionContext(sessionId: string): void;
}

export interface V2Deps {
  workingDir:          string;
  getBot:              () => SessionInjector | null;
  telegramLinkManager: TelegramLinkManager | null;
  slackLinkManager:    SlackLinkManager    | null;
  schedulerCallbacks:  SchedulerCallbacks  | null;
  channelStates:       Map<string, { running: boolean }>;
  sessionManager:      SessionManager;
  memoryManager:       MemoryManager;
  skillManager:        SkillManager;
  threadManager:       ThreadManager;
  integrationManager:  IntegrationManager;
  jwtContext:          InternalJWTPayload | null;
}

export interface V2Response {
  status: number;
  body:   unknown;
}

export type V2Handler = (
  method:   string,
  parts:    string[],
  req:      IncomingMessage,
  readBody: () => Promise<string>,
  deps:     V2Deps,
) => Promise<V2Response | null>;

// Standard response envelopes
export function ok(data: unknown, extra?: Record<string, unknown>): V2Response {
  return { status: 200, body: { ok: true, data, ...extra } };
}

export function created(data: unknown): V2Response {
  return { status: 201, body: { ok: true, data } };
}

export function err(status: number, message: string): V2Response {
  return { status, body: { ok: false, error: message } };
}
