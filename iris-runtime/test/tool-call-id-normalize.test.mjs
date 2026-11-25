// Regression for #308: history written by another model carries opaque tool-call
// ids; chat-completions models (Kimi) need `functions.<tool>:<n>`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmptyAssistantTurn, normalizeForeignToolCallIds } from "../dist/engine/context.js";

const kimi = { api: "openai-completions", id: "Kimi-K2.6" };
const history = () => [
	{ role: "user", content: "hi" },
	{
		role: "assistant",
		api: "openai-responses",
		model: "gpt-5.6-luna",
		content: [{ type: "toolCall", id: "call_abc|fc_1", name: "read", arguments: {} }],
	},
	{ role: "toolResult", toolCallId: "call_abc|fc_1", toolName: "read", content: [] },
];

test("rewrites foreign ids and matching tool results, without mutating input", () => {
	const input = history();
	const out = normalizeForeignToolCallIds(input, kimi);
	assert.equal(out[1].content[0].id, "functions.read:0");
	assert.equal(out[2].toolCallId, "functions.read:0");
	assert.equal(input[1].content[0].id, "call_abc|fc_1");
});

test("leaves same-model history and non-chat-completions targets alone", () => {
	const same = history();
	same[1].api = kimi.api;
	same[1].model = kimi.id;
	assert.equal(normalizeForeignToolCallIds(same, kimi)[1].content[0].id, "call_abc|fc_1");
	const input = history();
	assert.equal(normalizeForeignToolCallIds(input, { api: "anthropic-messages", id: "x" }), input);
});

test("isEmptyAssistantTurn", () => {
	const a = (content, stopReason = "stop") => ({ role: "assistant", stopReason, content });
	assert.equal(isEmptyAssistantTurn(a([{ type: "thinking", thinking: "..." }])), true);
	assert.equal(isEmptyAssistantTurn(a([{ type: "text", text: "  " }])), true);
	assert.equal(isEmptyAssistantTurn(a([{ type: "text", text: "ok" }])), false);
	assert.equal(isEmptyAssistantTurn(a([{ type: "toolCall", id: "1", name: "x" }])), false);
	assert.equal(isEmptyAssistantTurn(a([], "error")), false);
});
