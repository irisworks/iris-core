/**
 * IntegrationManager — unified lifecycle for Telegram and Slack integrations.
 * Wraps TelegramLinkManager and SlackLinkManager with a single interface.
 */

import type { TelegramLinkManager } from "../telegram-link.js";
import type { SlackLinkManager } from "../slack-link.js";

export type IntegrationType = "telegram" | "slack";

export interface IntegrationLinks {
  telegram: string | null;  // botId if linked, null otherwise
  slack:    string | null;  // workspaceId if linked, null otherwise
}

export class IntegrationManager {
  constructor(
    private telegram: TelegramLinkManager | null,
    private slack:    SlackLinkManager    | null,
  ) {}

  async generateToken(agentId: string, type: IntegrationType): Promise<string> {
    if (type === "telegram") {
      if (!this.telegram) throw new Error("Telegram not configured on this runtime");
      return this.telegram.generateToken(agentId);
    }
    if (!this.slack) throw new Error("Slack not configured on this runtime");
    return this.slack.generateToken(agentId);
  }

  async unlink(agentId: string, type: IntegrationType): Promise<boolean> {
    if (type === "telegram") return this.telegram?.unlinkAgent(agentId) ?? false;
    return this.slack?.unlinkAgent(agentId) ?? false;
  }

  async getLinks(agentId: string): Promise<IntegrationLinks> {
    const [tgBot, slackWs] = await Promise.all([
      this.telegram?.getBotForAgent(agentId)        ?? Promise.resolve(null),
      this.slack?.getWorkspaceForAgent?.(agentId)   ?? Promise.resolve(null),
    ]);
    return { telegram: tgBot ?? null, slack: slackWs ?? null };
  }

  invalidateCache(botId: string, workspaceId?: string): void {
    if (botId)         this.telegram?.invalidateCache(botId);
    if (workspaceId)   this.slack?.invalidateCache(workspaceId);
  }
}
