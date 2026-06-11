/**
 * BotFactory — creates Telegram bots by automating @BotFather via MTProto (GramJS).
 *
 * Requires a one-time service-account setup:
 *   TELEGRAM_API_ID    — integer, from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH  — string,  from https://my.telegram.org/apps
 *   TELEGRAM_SESSION   — GramJS StringSession string (generated once via scripts/gen-tg-session.ts)
 *
 * When any of these are absent, createTelegramBot() throws BotFactoryUnavailableError
 * immediately — the caller in v2-sub-agents returns 503 so the frontend can fall back
 * to the manual-token-paste path without breaking anything.
 *
 * All bot creations are serialised through a single in-process queue. BotFather enforces
 * a sequential conversational flow and rate-limits accounts that send bursts, so no two
 * creation flows may run concurrently.
 */

import { TelegramClient, sessions } from "telegram";
import * as log from "./log.js";

// ── Config ──────────────────────────────────────────────────────────────────

const API_ID   = parseInt(process.env.TELEGRAM_API_ID   ?? "0", 10);
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";
const SESSION  = process.env.TELEGRAM_SESSION  ?? "";

const BOTFATHER        = "botfather";
const REPLY_TIMEOUT_MS = 15_000;
const STEP_DELAY_MS    = 1_500;  // human-like pacing — BotFather rejects bursts
const POLL_INTERVAL_MS = 600;

// ── Public types ─────────────────────────────────────────────────────────────

export class BotFactoryUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BotFactoryUnavailableError";
  }
}

export interface BotCreateResult {
  botToken:    string;
  botUsername: string;
}

// ── Singleton client + resolved BotFather entity ─────────────────────────────

let _client:    TelegramClient | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _botfather: any              = null; // resolved peer entity, avoids repeated contacts.ResolveUsername calls

async function ensureClient(): Promise<TelegramClient> {
  if (!API_ID || !API_HASH || !SESSION) {
    throw new BotFactoryUnavailableError(
      "BotFactory not configured — set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION",
    );
  }
  if (_client) return _client; // reuse; GramJS handles reconnection internally

  const c = new TelegramClient(new sessions.StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
  });
  await c.connect();
  _client = c;
  log.logInfo("[bot-factory] Connected to Telegram MTProto");
  return c;
}

// ── BotFather reply polling ───────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Record the ID of the last message in the BotFather conversation before we
 * send anything — used as a watermark so we only look at BotFather's reply,
 * not at older messages.
 */
async function watermark(client: TelegramClient): Promise<number> {
  // Use cached _botfather entity to avoid repeated contacts.ResolveUsername calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = await client.getMessages(_botfather, { limit: 1 });
  return (msgs[0]?.id as number | undefined) ?? 0;
}

/**
 * Poll the BotFather conversation until a new incoming message arrives after
 * `afterId`. Returns the message text. Throws on timeout.
 */
async function waitForReply(client: TelegramClient, afterId: number): Promise<string> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    // Use cached entity — avoids contacts.ResolveUsername on every poll tick
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = await client.getMessages(_botfather, { limit: 5, minId: afterId });
    // Filter to incoming messages only (out === false means BotFather sent it)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const incoming = msgs.filter((m: any) => !m.out && (m.id as number) > afterId);
    if (incoming.length > 0) {
      // Sort descending and take the most recent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      incoming.sort((a: any, b: any) => (b.id as number) - (a.id as number));
      return (incoming[0].message as string) ?? "";
    }
  }
  throw new Error("BotFather did not respond within 15 seconds");
}

// ── BotFather conversation ────────────────────────────────────────────────────

interface FlowSuccess   { kind: "success"; token: string }
interface FlowCollision { kind: "collision" }
type FlowResult = FlowSuccess | FlowCollision;

/**
 * Run the three-step /newbot conversation with BotFather.
 * Each step polls for BotFather's reply before proceeding to the next.
 */
async function runBotFatherFlow(
  client: TelegramClient,
  displayName: string,
  username: string,
): Promise<FlowResult> {
  // Resolve BotFather entity once per process — avoids repeated contacts.ResolveUsername
  // calls (which trigger flood-wait errors) on every getMessages/sendMessage.
  if (!_botfather) {
    _botfather = await client.getEntity(BOTFATHER);
  }

  // Step 0 — /cancel to ensure BotFather is in a clean idle state before we
  // start. Without this, a previous abandoned /newbot conversation leaves
  // BotFather mid-flow and our subsequent messages get unrecognized replies.
  await client.sendMessage(_botfather, { message: "/cancel" });
  await delay(STEP_DELAY_MS);

  // Step 1 — /newbot
  const w1 = await watermark(client);
  await client.sendMessage(_botfather, { message: "/newbot" });
  const reply1 = await waitForReply(client, w1); // "Alright, a new bot. How are we going to call it?"
  // Detect BotFather's per-account rate-limit block ("too many attempts")
  const blockMatch = reply1.match(/try again in (\d+) seconds/i);
  if (blockMatch) {
    const secs = parseInt(blockMatch[1], 10);
    const mins = Math.ceil(secs / 60);
    throw new Error(`BotFather rate-limited: try again in ${mins} minute${mins === 1 ? "" : "s"} (${secs}s)`);
  }
  if (!/alright|new bot|call it|name/i.test(reply1)) {
    throw new Error(`BotFather did not enter /newbot flow: "${reply1.slice(0, 120)}"`);
  }
  await delay(STEP_DELAY_MS);

  // Step 2 — display name
  const w2 = await watermark(client);
  await client.sendMessage(_botfather, { message: displayName });
  const reply2 = await waitForReply(client, w2); // "Good. Now let's choose a username..."
  if (/sorry|invalid|too long|must|please/i.test(reply2) && !/username/i.test(reply2)) {
    throw new Error(`BotFather rejected display name "${displayName}": "${reply2.slice(0, 120)}"`);
  }
  await delay(STEP_DELAY_MS);

  // Step 3 — username
  const w3 = await watermark(client);
  await client.sendMessage(_botfather, { message: username });
  const reply = await waitForReply(client, w3);

  // BotFather collision / invalid response
  if (/already taken|invalid|sorry/i.test(reply) && !/congratulations|done!/i.test(reply)) {
    return { kind: "collision" };
  }

  // Extract token — BotFather format: "...Use this token to access the HTTP API:\n{token}\n..."
  const tokenMatch = reply.match(/(\d{8,12}:[A-Za-z0-9_-]{35,46})/);
  if (!tokenMatch) {
    throw new Error(`BotFather response unrecognized: "${reply.slice(0, 140)}"`);
  }

  return { kind: "success", token: tokenMatch[1] };
}

// ── Username helpers ──────────────────────────────────────────────────────────

function makeUsername(desiredName: string, suffix = ""): string {
  // Telegram usernames: lowercase alphanumeric + underscores, must end in "bot"
  const base = desiredName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  return `${base}${suffix}_iris_bot`;
}

// ── Public API ────────────────────────────────────────────────────────────────

// All creations run through this chain serially — never in parallel
let _queue: Promise<unknown> = Promise.resolve();

/**
 * Create a Telegram bot via BotFather. Queued serially to respect BotFather's
 * rate limits. Retries once with a 4-digit random suffix if the username is taken.
 *
 * Throws BotFactoryUnavailableError if env vars are missing → caller returns 503.
 * Throws generic Error for BotFather-level failures → caller returns 502.
 */
export async function createTelegramBot(desiredName: string): Promise<BotCreateResult> {
  return new Promise<BotCreateResult>((resolve, reject) => {
    _queue = _queue.then(async () => {
      try {
        const client      = await ensureClient();
        const displayName = `${desiredName} Bot`;
        const username    = makeUsername(desiredName);

        // GramJS surfaces Telegram flood-waits as errors with message
        // "A wait of N seconds is required (caused by ...)" — wait and retry once.
        const runWithFloodRetry = async (u: string): Promise<FlowResult> => {
          try {
            return await runBotFatherFlow(client, displayName, u);
          } catch (e) {
            const wait = typeof e === "object" && e !== null && "seconds" in e
              ? (e as { seconds: number }).seconds
              : (() => { const m = (e instanceof Error ? e.message : "").match(/wait of (\d+) seconds/); return m ? parseInt(m[1], 10) : 0; })();
            if (wait > 0) {
              log.logInfo(`[bot-factory] Flood-wait ${wait}s — retrying after cooldown`);
              await delay(wait * 1000 + 2000);
              return await runBotFatherFlow(client, displayName, u);
            }
            throw e;
          }
        };

        const result = await runWithFloodRetry(username);

        if (result.kind === "collision") {
          const fallback = makeUsername(desiredName, `_${Math.floor(Math.random() * 9000 + 1000)}`);
          log.logWarning(`[bot-factory] @${username} taken — retrying as @${fallback}`);
          await delay(STEP_DELAY_MS);

          const retry = await runWithFloodRetry(fallback);
          if (retry.kind === "collision") {
            throw new Error(`All username variants for "${desiredName}" are taken — choose a different name`);
          }
          log.logInfo(`[bot-factory] Created @${fallback} (display: "${displayName}")`);
          resolve({ botToken: retry.token, botUsername: fallback });
          return;
        }

        log.logInfo(`[bot-factory] Created @${username} (display: "${displayName}")`);
        resolve({ botToken: result.token, botUsername: username });
      } catch (e) {
        reject(e);
      }
    });
  });
}
