/**
 * IntegrationManager — dedicated bot/app lifecycle for sub-agents.
 *
 * Replaces the old TelegramLinkManager/SlackLinkManager pool-claim model.
 * Each sub-agent owns its own Telegram Bot and Slack App (no shared pool, no
 * 1-of-N claiming) — credentials live as Key Vault refs directly on sub_agents
 * (see sub-agent-registry.ts: attachIntegration/detachIntegration/markIntegrationLinked).
 *
 * Claim tokens are NOT eliminated by the dedicated-bot model — they remain as
 * an ownership-verification step: anyone could paste a stolen token string into
 * the attach form, but only the real owner can make *their* bot deliver the
 * token back to Iris. Tokens are stored in Supabase `claim_tokens` (the schema's
 * documented replacement for the old local-file token storage).
 */

import { randomBytes } from "crypto";
import { getDb } from "../db.js";
import {
  attachIntegration,
  detachIntegration,
  markIntegrationLinked,
  getSubAgent,
  type IntegrationKind,
  type IntegrationStatus,
} from "../sub-agent-registry.js";
import * as log from "../log.js";

export type { IntegrationKind } from "../sub-agent-registry.js";

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes, single-use — matches the old claim-token contract

export interface IntegrationStatusSummary {
  telegram: IntegrationStatus;
  slack: IntegrationStatus;
}

export interface AttachResult {
  claimToken:       string;
  expiresInSeconds: number;
  instructions:     string;
  botUsername?:     string;  // Telegram only — @username of the dedicated bot
  qrUrl?:           string;  // Telegram only — deep link: t.me/{username}?start={token}
}

async function getBotUsername(token: string): Promise<string | null> {
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8_000) });
    const body = await res.json() as { ok: boolean; result?: { username?: string } };
    return body.ok ? (body.result?.username ?? null) : null;
  } catch {
    return null;
  }
}

export class IntegrationManager {
  /**
   * Store dedicated-bot credentials and issue a claim token for ownership
   * verification. The caller (API layer) must re-provision the agent's
   * container afterward so the token becomes a live env var.
   */
  async attach(
    agentId: string,
    platform: IntegrationKind,
    credentials: { telegramBotToken?: string; slackAppToken?: string; slackBotToken?: string },
  ): Promise<AttachResult> {
    const agent = await getSubAgent(agentId);
    if (!agent) throw new Error(`Sub-agent ${agentId} not found`);

    const current = platform === "telegram" ? agent.telegramStatus : agent.slackStatus;
    if (current === "linked") {
      throw new Error(`${platform} is already linked to "${agent.name}". Detach it first.`);
    }

    // Resolve bot username via getMe before persisting — lets us store it alongside
    // the ref and build the QR deep-link in a single attach call.
    let botUsername: string | undefined;
    if (platform === "telegram" && credentials.telegramBotToken) {
      botUsername = await getBotUsername(credentials.telegramBotToken) ?? undefined;
      if (!botUsername) log.logWarning("[integration] attach: getMe returned no username — QR link will be omitted");
    }

    const updated = await attachIntegration(agentId, platform, { ...credentials, botUsername });
    if (!updated) throw new Error(`Failed to store ${platform} credentials`);

    const claimToken = await this.issueClaimToken(agentId, platform);

    const dest = platform === "telegram"
      ? "your Telegram bot"
      : "your Slack app (as a direct message to its bot user)";
    const instructions = `Send this token to ${dest} to prove you control it and finish linking "${agent.name}". Token expires in ${TOKEN_TTL_MS / 60_000} minutes.`;

    if (platform === "telegram" && botUsername) {
      const qrUrl = `https://t.me/${botUsername}?start=${claimToken}`;
      return { claimToken, expiresInSeconds: TOKEN_TTL_MS / 1000, instructions, botUsername, qrUrl };
    }

    return { claimToken, expiresInSeconds: TOKEN_TTL_MS / 1000, instructions };
  }

  /**
   * Verify ownership: the dedicated bot calls this back (via IRIS_API_URL,
   * the same callback pattern used for escalation/self-heal) after receiving
   * the claim token from its owner. Single-use — the token is consumed on
   * first valid use regardless of outcome.
   */
  async verify(agentId: string, platform: IntegrationKind, token: string): Promise<boolean> {
    const db = getDb();
    if (!db) {
      log.logWarning("[integration] verify: Supabase not configured — cannot validate claim tokens");
      return false;
    }
    try {
      const { data, error } = await db
        .from("claim_tokens")
        .select("agent_id, type, expires_at, used_at")
        .eq("token", token)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;

      const row = data as { agent_id: string; type: string; expires_at: string; used_at: string | null };
      const valid =
        row.agent_id === agentId &&
        row.type === platform &&
        row.used_at === null &&
        new Date(row.expires_at).getTime() > Date.now();

      // Single-use regardless of outcome — burn it so a leaked token can't be retried
      await db.from("claim_tokens").update({ used_at: new Date().toISOString() }).eq("token", token);

      if (!valid) {
        log.logWarning(`[integration] verify: invalid/expired/mismatched token for agent ${agentId} (${platform})`);
        return false;
      }

      await markIntegrationLinked(agentId, platform);
      return true;
    } catch (err) {
      log.logWarning(`[integration] verify(${platform}) failed`, String(err));
      return false;
    }
  }

  /**
   * Detach: deletes Key Vault secret(s), clears refs, resets status. The
   * caller (API layer) must re-provision the container afterward to drop
   * the now-stale env var from the running bot.
   */
  async detach(agentId: string, platform: IntegrationKind): Promise<boolean> {
    await this.invalidatePendingTokens(agentId, platform);
    return detachIntegration(agentId, platform);
  }

  async getStatus(agentId: string): Promise<IntegrationStatusSummary> {
    const agent = await getSubAgent(agentId);
    return {
      telegram: agent?.telegramStatus ?? "unattached",
      slack:    agent?.slackStatus    ?? "unattached",
    };
  }

  // ── Claim tokens (Supabase claim_tokens — replaces local JSON file storage) ──

  private async issueClaimToken(agentId: string, platform: IntegrationKind): Promise<string> {
    const db = getDb();
    const token = randomBytes(32).toString("hex");
    if (!db) {
      log.logWarning("[integration] issueClaimToken: Supabase not configured — token will not persist");
      return token;
    }
    try {
      // Invalidate any unused tokens of this type for this agent — single active token at a time
      await this.invalidatePendingTokens(agentId, platform);
      const { error } = await db.from("claim_tokens").insert({
        token,
        agent_id: agentId,
        type: platform,
        expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      });
      if (error) throw error;
      log.logInfo(`[integration] Claim token issued for agent ${agentId} (${platform})`);
      return token;
    } catch (err) {
      log.logWarning(`[integration] issueClaimToken(${platform}) failed`, String(err));
      return token;
    }
  }

  private async invalidatePendingTokens(agentId: string, platform: IntegrationKind): Promise<void> {
    const db = getDb();
    if (!db) return;
    try {
      await db.from("claim_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("agent_id", agentId)
        .eq("type", platform)
        .is("used_at", null);
    } catch (err) {
      log.logWarning(`[integration] invalidatePendingTokens(${platform}) failed`, String(err));
    }
  }
}
