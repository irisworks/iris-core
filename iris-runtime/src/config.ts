/**
 * Centralised runtime configuration.
 *
 * All process.env reads happen here and nowhere else.
 * Consumers receive a typed, validated config object — not raw env strings.
 */

export interface SlackConfig {
	appToken: string | undefined;
	botToken: string | undefined;
	/** Channel IDs this instance responds to. Empty = all channels. */
	channelFilter: string[];
}

export interface IrisConfig {
	slack: SlackConfig;
	provider: string;
	model: string;
	environment: "preview" | "prod";
	/** Internal API port (default 3000). */
	apiPort: number;
	/** Bridge server port. 0 = disabled. */
	bridgePort: number;
	llmTimeoutSecs: number;
	telegramBridgeUrl: string;
	passthroughApiKey: string;
}

export function loadConfig(): IrisConfig {
	const channelFilter = (process.env.IRIS_SLACK_CHANNEL ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);

	return {
		slack: {
			appToken: process.env.IRIS_SLACK_APP_TOKEN,
			botToken: process.env.IRIS_SLACK_BOT_TOKEN,
			channelFilter,
		},
		provider: process.env.IRIS_PROVIDER ?? "anthropic",
		model: process.env.IRIS_MODEL ?? "claude-sonnet-4-5",
		environment: (process.env.IRIS_ENV as "preview" | "prod") ?? "prod",
		apiPort: parseInt(process.env.IRIS_API_PORT ?? "0", 10) || 3000,
		bridgePort: parseInt(process.env.IRIS_BRIDGE_PORT ?? "0", 10),
		llmTimeoutSecs: Number(process.env.IRIS_LLM_TIMEOUT_SECS) || 300,
		telegramBridgeUrl: process.env.TELEGRAM_BRIDGE_URL ?? "http://localhost:3001",
		passthroughApiKey: process.env.PASSTHROUGH_API_KEY ?? "",
	};
}
