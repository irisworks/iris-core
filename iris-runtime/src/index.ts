// ============================================================================
// Package entry point — barrel for consumers importing @iris-core/runtime as
// a library (vs. running dist/main.js as the CLI). Exports the engine and the
// transport type contracts a host would need to implement a new transport or
// drive the engine directly.
// ============================================================================

export {
	createEngine,
	type ChannelState,
	type Engine,
	type EngineConfig,
	type EngineTransport,
} from "./engine/index.js";

export {
	getPromptProfile,
	registerPromptProfile,
	type ChannelInfo,
	type ChannelTransport,
	type MessageContext,
	type ToolEvent,
	type TransportEvent,
	type TransportPromptProfile,
	type UserInfo,
} from "./transport/types.js";
