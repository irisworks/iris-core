// Reply-threading (issue #157): when a Telegram user replies to an earlier
// message, the Bot API update carries that message on `reply_to_message`, but
// Iris only ever saw the reply's own text — it couldn't resolve what "this
// one?" referred to. withReplyContext prepends the referenced message's
// content (or a content-type note when it has no text, e.g. a bare photo) so
// the referenced message is visible in the text Iris receives.

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeReplyTarget, withReplyContext } from "../dist/transports/telegram/telegram.js";

test("withReplyContext: no reply_to_message leaves text untouched", () => {
	assert.equal(withReplyContext("This one?", undefined), "This one?");
});

test("withReplyContext: prepends the referenced text message", () => {
	const replyTo = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, from: { id: 2, username: "rohit" }, text: "what is the capital of France?" };
	const result = withReplyContext("This one?", replyTo);
	assert.match(result, /^\[Replying to @rohit: "what is the capital of France\?"\]\n/);
	assert.match(result, /This one\?$/);
});

test("withReplyContext: falls back to first_name when no username", () => {
	const replyTo = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, from: { id: 2, first_name: "Rohit" }, text: "hello" };
	assert.match(withReplyContext("hi", replyTo), /^\[Replying to Rohit: "hello"\]/);
});

test("withReplyContext: uses caption when the referenced message has no text", () => {
	const replyTo = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, photo: [{ file_id: "f", width: 1, height: 1 }], caption: "look at this" };
	assert.match(withReplyContext("nice!", replyTo), /^\[Replying to the earlier message: "look at this"\]/);
});

test("describeReplyTarget: media-only messages describe their content type", () => {
	assert.equal(describeReplyTarget({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, photo: [{ file_id: "f", width: 1, height: 1 }] }), "[a photo]");
	assert.equal(
		describeReplyTarget({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, document: { file_id: "f", file_name: "notes.pdf" } }),
		"[a file: notes.pdf]",
	);
	assert.equal(describeReplyTarget({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, voice: { file_id: "f" } }), "[a voice message]");
});

test("describeReplyTarget: no message and no content returns null", () => {
	assert.equal(describeReplyTarget(undefined), null);
	assert.equal(describeReplyTarget({ message_id: 1, date: 0, chat: { id: 1, type: "private" } }), null);
});
