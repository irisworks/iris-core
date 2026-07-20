// ============================================================================
// Gateway service map — which upstream a /proxy/<service>/... call forwards
// to, and which stored secret gets injected into which header.
//
// Bundled defaults cover the services iris-core already integrates with.
// Operators extend/override them via a JSON file (IRIS_BROKER_SERVICES_FILE,
// default /iris/broker/services.json) with the same shape:
//
//   { "myapi": { "upstream": "https://api.example.com",
//                "secret": "MYAPI-KEY",
//                "headers": { "Authorization": "Bearer {value}" } } }
//
// "{value}" is replaced with the secret's plaintext at forward time.
// ============================================================================

import { existsSync, readFileSync } from "fs";
import * as log from "../engine/log.js";

export interface GatewayService {
	upstream: string;
	secret: string;
	headers: Record<string, string>;
}

export const BUNDLED_SERVICES: Record<string, GatewayService> = {
	resend: {
		upstream: "https://api.resend.com",
		secret: "RESEND-API-KEY",
		headers: { Authorization: "Bearer {value}" },
	},
	github: {
		upstream: "https://api.github.com",
		secret: "GITHUB-TOKEN",
		headers: { Authorization: "Bearer {value}" },
	},
	anthropic: {
		upstream: "https://api.anthropic.com",
		secret: "ANTHROPIC-API-KEY",
		headers: { "x-api-key": "{value}" },
	},
	openai: {
		upstream: "https://api.openai.com",
		secret: "OPENAI-API-KEY",
		headers: { Authorization: "Bearer {value}" },
	},
	slack: {
		upstream: "https://slack.com/api",
		secret: "IRIS-SLACK-BOT-TOKEN",
		headers: { Authorization: "Bearer {value}" },
	},
};

/** Bundled defaults merged with the operator file (operator entries win). */
export function loadServices(): Record<string, GatewayService> {
	const file = process.env.IRIS_BROKER_SERVICES_FILE ?? "/iris/broker/services.json";
	if (!existsSync(file)) return { ...BUNDLED_SERVICES };
	try {
		const operator = JSON.parse(readFileSync(file, "utf8")) as Record<string, GatewayService>;
		return { ...BUNDLED_SERVICES, ...operator };
	} catch (err) {
		log.logWarning(`[broker] cannot parse ${file} — using bundled service map only`, err instanceof Error ? err.message : String(err));
		return { ...BUNDLED_SERVICES };
	}
}
