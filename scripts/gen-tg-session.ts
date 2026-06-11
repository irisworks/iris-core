/**
 * One-time script to generate a GramJS StringSession for the BotFactory
 * service account. Run once, copy the session string to Key Vault, inject
 * it as TELEGRAM_SESSION in the runtime environment.
 *
 * Usage:
 *   cd iris-runtime
 *   npx ts-node --esm ../scripts/gen-tg-session.ts
 *
 * You will need:
 *   - A dedicated Telegram phone number for the service account
 *   - TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org/apps
 *
 * The generated session string is sensitive — treat it like a password.
 * Store it in Azure Key Vault and inject via the VM Orchestrator env vars.
 * Never commit it to the repository.
 */

import { TelegramClient, sessions } from "telegram";
import * as readline from "readline";

const API_ID   = parseInt(process.env.TELEGRAM_API_ID   ?? "", 10);
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";

if (!API_ID || !API_HASH) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

const client = new TelegramClient(new sessions.StringSession(""), API_ID, API_HASH, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: async () => ask("Service account phone number (e.g. +12125550100): "),
  password:    async () => ask("2FA password (press Enter if none): "),
  phoneCode:   async () => ask("Telegram verification code: "),
  onError:     (err: Error) => { console.error("Auth error:", err.message); },
});

const sessionString = (client.session as sessions.StringSession).save();
console.log("\n✓ Session generated successfully.\n");
console.log("SESSION STRING (store in Key Vault as TELEGRAM_SESSION):");
console.log("─".repeat(60));
console.log(sessionString);
console.log("─".repeat(60));
console.log("\nNever commit this string to the repository.");

rl.close();
await client.disconnect();
