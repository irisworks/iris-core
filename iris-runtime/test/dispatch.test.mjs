// Dispatch regression suite — the committed port of the synthetic-event
// harness that verified iris-core PR #37 (channel-mode consistency fixes).
// Drives the compiled handlers through mode × message-path combinations:
// config resolution (incl. wildcard precedence), passthrough forwarding
// shapes, admin commands, leads replay and queue bound, session creation and
// gating, and single-ack (including on handler error).
//
// This is the safety net for the presets-over-flags dispatch rewrite: the new
// pipeline must keep every assertion here green (modulo IRIS-53 decisions).

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, loadSessions } from "../dist/engine/sessions.js";
import { resolveChannelDir } from "../dist/engine/store.js";
import { parseAdminCommand, parseVerboseCommand } from "../dist/engine/dispatch.js";
import { fillQueue, makeBot, settle } from "./helpers.mjs";

// ============================================================================
// Config resolution (wildcard precedence, unknown modes, half-applied configs)
// ============================================================================

test("config: exact match beats wildcard", () => {
	const { bot } = makeBot({
		channels: { "D*": { mode: "leads" }, DEXACT: { mode: "admin" } },
	});
	assert.equal(bot.getChannelMode("DEXACT"), "admin");
	assert.equal(bot.getChannelMode("DOTHER"), "leads");
});

test("config: longest matching prefix wins regardless of file order", () => {
	const { bot } = makeBot({
		channels: { "D*": { mode: "leads" }, "DA*": { mode: "admin" } },
	});
	assert.equal(bot.getChannelMode("DAXXX"), "admin");
	assert.equal(bot.getChannelMode("DBXXX"), "leads");

	// Reversed insertion order must not change the winner
	const { bot: bot2 } = makeBot({
		channels: { "DA*": { mode: "admin" }, "D*": { mode: "leads" } },
	});
	assert.equal(bot2.getChannelMode("DAXXX"), "admin");
});

test("config: wildcard entries resolve ALL settings, not just mode", () => {
	const { bot } = makeBot({
		channels: {
			"C0*": {
				mode: "passthrough",
				url: "https://relay.example/hook",
				requireMentionForTopLevel: true,
				payload: { q: "{{text}}" },
			},
		},
	});
	assert.equal(bot.getChannelMode("C0LEAD"), "passthrough");
	assert.equal(bot.getPassthroughConfig("C0LEAD")?.url, "https://relay.example/hook");
	assert.deepEqual(bot.getPassthroughConfig("C0LEAD")?.payload, { q: "{{text}}" });
	assert.equal(bot.requiresMentionForTopLevel("C0LEAD"), true);
});

test("config: unknown mode entry is skipped entirely (no half-applied settings)", () => {
	const { bot } = makeBot({
		channels: { CBAD: { mode: "bogus-mode", requireMentionForTopLevel: true } },
	});
	assert.equal(bot.getChannelMode("CBAD"), "dm"); // default
	assert.equal(bot.requiresMentionForTopLevel("CBAD"), false); // NOT applied
});

test("config: unconfigured channel defaults to dm mode", () => {
	const { bot } = makeBot({});
	assert.equal(bot.getChannelMode("CANY"), "dm");
});

// ============================================================================
// app_mention path
// ============================================================================

test("mention: dm-mode channel dispatches an LLM run with mention stripped", async () => {
	const { calls, mention } = makeBot({});
	const ack = mention({ text: "<@UBOT> hello there", channel: "C1", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.text, "hello there");
	assert.equal(calls.events[0].event.channel, "C1");
	assert.equal(ack.count, 1);
});

test("mention: DM channel ids are skipped (message event handles DMs)", async () => {
	const { calls, mention } = makeBot({});
	const ack = mention({ text: "<@UBOT> hi", channel: "D123", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.events.length, 0);
	assert.equal(ack.count, 1); // still acked exactly once
});

test("mention: an explicit mention runs admin commands in every chat mode, not just admin", async () => {
	const { calls, mention } = makeBot({
		channels: { CADM: { mode: "admin" }, CLEADS: { mode: "leads" } },
		isRunning: () => true,
	});
	mention({ text: "<@UBOT> stop", channel: "CADM", user: "U1", ts: "1000.0001" });
	mention({ text: "<@UBOT> compact", channel: "CADM", user: "U1", ts: "1000.0002" });
	mention({ text: "<@UBOT> reset", channel: "CADM", user: "U1", ts: "1000.0003" });
	// dm mode (the default) and leads: addressed to Iris, so still commands
	mention({ text: "<@UBOT> stop", channel: "CPLAIN", user: "U1", ts: "1000.0004" });
	mention({ text: "<@UBOT> stop", channel: "CLEADS", user: "U1", ts: "1000.0005" });
	await settle();
	assert.deepEqual(calls.stops, ["CADM", "CPLAIN", "CLEADS"]);
	assert.deepEqual(calls.compacts, ["CADM"]);
	assert.deepEqual(calls.resets, ["CADM"]);
	assert.equal(calls.events.length, 0);
});

test("mention: clear is accepted as an alias for reset (#109)", async () => {
	const { calls, mention } = makeBot({
		channels: { CADM: { mode: "admin" } },
		isRunning: () => true,
	});
	mention({ text: "<@UBOT> clear", channel: "CADM", user: "U1", ts: "1000.0001" });
	await settle();
	assert.deepEqual(calls.resets, ["CADM"]);
	assert.equal(calls.events.length, 0);
});

test("mention: stop while idle posts _Nothing running_ instead of handleStop", async () => {
	const { calls, mention } = makeBot({
		channels: { CADM: { mode: "admin" } },
		isRunning: () => false,
	});
	mention({ text: "<@UBOT> stop", channel: "CADM", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.stops.length, 0);
	assert.deepEqual(calls.posted, [{ channel: "CADM", text: "_Nothing running_" }]);
});

// ============================================================================
// Verbose toggle (parseVerboseCommand + the mention/DM interception, which —
// unlike stop/compact/reset — is NOT gated behind admin mode)
// ============================================================================

test("parseVerboseCommand: on/off/status, case-insensitive, trimmed, non-matches", () => {
	assert.equal(parseVerboseCommand("verbose on"), "on");
	assert.equal(parseVerboseCommand("  Verbose ON  "), "on");
	assert.equal(parseVerboseCommand("verbose off"), "off");
	assert.equal(parseVerboseCommand("VERBOSE OFF"), "off");
	assert.equal(parseVerboseCommand("verbose"), "status");
	assert.equal(parseVerboseCommand("verbose status"), "status");
	assert.equal(parseVerboseCommand("verbose maybe"), false);
	assert.equal(parseVerboseCommand("stop"), false);
	assert.equal(parseVerboseCommand(""), false);
});

test("mention: verbose on/off/status works in dm mode too, not just admin mode", async () => {
	const { calls, mention } = makeBot({
		channels: { CDM: { mode: "dm" } },
	});
	mention({ text: "<@UBOT> verbose on", channel: "CDM", user: "U1", ts: "1000.0001" });
	mention({ text: "<@UBOT> verbose off", channel: "CDM", user: "U1", ts: "1000.0002" });
	mention({ text: "<@UBOT> verbose", channel: "CDM", user: "U1", ts: "1000.0003" });
	await settle();
	assert.deepEqual(calls.verbose, [
		{ channelId: "CDM", action: "on" },
		{ channelId: "CDM", action: "off" },
		{ channelId: "CDM", action: "status" },
	]);
	assert.equal(calls.events.length, 0); // intercepted, never dispatched as chat
});

test("message: verbose on works from a plain DM (dm mode), unlike stop/compact/reset", async () => {
	const { calls, message } = makeBot({
		channels: { DPLAIN: { mode: "dm" } },
	});
	message({ text: "verbose on", channel: "DPLAIN", user: "U1", ts: "1000.0001", channel_type: "im" });
	await settle();
	assert.deepEqual(calls.verbose, [{ channelId: "DPLAIN", action: "on" }]);
	assert.equal(calls.events.length, 0);
});

test("message: bare top-level 'verbose on' with no mention/DM is not intercepted as a control command", async () => {
	const { calls, message } = makeBot({
		channels: { CLEADS: { mode: "leads" } },
	});
	message({ text: "verbose on", channel: "CLEADS", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.verbose.length, 0);
	assert.equal(calls.events.length, 1); // falls through as ordinary chat text (leads dispatches all top-level)
});

// ============================================================================
// Slash-command spellings (#156) — the parse-level `/` tolerance plus the
// native Slack slash_commands envelope
// ============================================================================

test("parseAdminCommand: bare and slash-prefixed spellings, case-insensitive, trimmed", () => {
	assert.equal(parseAdminCommand("stop"), "stop");
	assert.equal(parseAdminCommand("/stop"), "stop");
	assert.equal(parseAdminCommand("  /Stop  "), "stop");
	assert.equal(parseAdminCommand("/compact"), "compact");
	assert.equal(parseAdminCommand("/reset"), "reset");
	assert.equal(parseAdminCommand("/clear"), "reset");
	assert.equal(parseAdminCommand("//stop"), false);
	assert.equal(parseAdminCommand("/stop it"), false);
	assert.equal(parseAdminCommand("please stop"), false);
	assert.equal(parseAdminCommand(""), false);
});

test("parseVerboseCommand: slash-prefixed spellings work too", () => {
	assert.equal(parseVerboseCommand("/verbose on"), "on");
	assert.equal(parseVerboseCommand("/verbose off"), "off");
	assert.equal(parseVerboseCommand("/verbose"), "status");
	assert.equal(parseVerboseCommand("/verbose maybe"), false);
});

test("mention: '@iris /stop' runs the admin command instead of becoming a prompt", async () => {
	const { calls, mention } = makeBot({
		channels: { CADM: { mode: "admin" } },
		isRunning: () => true,
	});
	mention({ text: "<@UBOT> /stop", channel: "CADM", user: "U1", ts: "1000.0001" });
	mention({ text: "<@UBOT> /clear", channel: "CADM", user: "U1", ts: "1000.0002" });
	await settle();
	assert.deepEqual(calls.stops, ["CADM"]);
	assert.deepEqual(calls.resets, ["CADM"]);
	assert.equal(calls.events.length, 0);
});

test("slash: /stop, /compact, /clear run admin commands in a chat channel", async () => {
	const { calls, slash } = makeBot({
		channels: { CADM: { mode: "admin" }, CLEADS: { mode: "leads" } },
		isRunning: () => true,
	});
	const ack = slash({ command: "/stop", text: "", channel_id: "CDM" }); // unconfigured: dm mode
	slash({ command: "/compact", text: "", channel_id: "CADM" });
	slash({ command: "/clear", text: "", channel_id: "CLEADS" });
	await settle();
	assert.deepEqual(calls.stops, ["CDM"]);
	assert.deepEqual(calls.compacts, ["CADM"]);
	assert.deepEqual(calls.resets, ["CLEADS"]);
	assert.equal(ack.count, 1);
	assert.equal(ack.responses[0], undefined); // plain ack, no ephemeral reply
});

test("slash: refused in a sessions channel — a slash command carries no thread to act on", async () => {
	const { calls, slash } = makeBot({
		channels: { CTH: { mode: "thread" }, CIT: { mode: "interactive-thread" } },
		isRunning: () => true,
	});
	const threadAck = slash({ command: "/clear", text: "", channel_id: "CTH" });
	const itAck = slash({ command: "/stop", text: "", channel_id: "CIT" });
	await settle();
	assert.equal(calls.resets.length, 0); // must NOT clear the (unused) channel context
	assert.equal(calls.stops.length, 0);
	assert.match(threadAck.responses[0].text, /one session per thread/);
	assert.match(itAck.responses[0].text, /one session per thread/);
});

test("message: a control command in a session thread targets that session's run, not the channel", async () => {
	const { bot, calls, message, mention, workingDir } = makeBot({
		channels: { CIT: { mode: "interactive-thread" } },
		isRunning: () => true,
	});
	const session = createSession(workingDir, { originChannel: "CIT", originThreadTs: "999.0001" });
	// Every reply in a session thread is addressed to Iris, so no mention is needed
	message({ text: "stop", channel: "CIT", user: "U1", ts: "1000.0001", thread_ts: "999.0001" });
	await settle();
	assert.deepEqual(calls.stops, [`SESSION-${session.sessionId}`]);
	assert.equal(calls.events.length, 0); // never reaches the LLM as a prompt
	// The status message is routed back into the originating thread even though no
	// message had registered the session's route in this process yet.
	assert.deepEqual(bot.sessionRoutes.get(`SESSION-${session.sessionId}`), { channel: "CIT", threadTs: "999.0001" });

	mention({ text: "<@UBOT> /clear", channel: "CIT", user: "U1", ts: "1000.0002", thread_ts: "999.0001" });
	await settle();
	assert.deepEqual(calls.resets, [`SESSION-${session.sessionId}`]);
});

test("message: a top-level control command in a sessions channel is not intercepted", async () => {
	const { calls, message, mention } = makeBot({
		channels: { CTH: { mode: "thread" }, CIT: { mode: "interactive-thread" } },
		isRunning: () => true,
	});
	// No session exists yet, so there is nothing for the command to act on — acting
	// on the channel would report success while aborting and clearing nothing.
	mention({ text: "<@UBOT> stop", channel: "CTH", user: "U1", ts: "1000.0001" });
	message({ text: "stop", channel: "CIT", user: "U1", ts: "1000.0002" });
	await settle();
	assert.equal(calls.stops.length, 0);
	assert.equal(calls.resets.length, 0);
});

test("slash: trailing text is ignored, /verbose reads its argument", async () => {
	const { calls, slash } = makeBot({ channels: { CDM: { mode: "dm" } }, isRunning: () => true });
	slash({ command: "/stop", text: "now please", channel_id: "CDM" });
	slash({ command: "/verbose", text: "on", channel_id: "CDM" });
	slash({ command: "/verbose", text: "", channel_id: "CDM" });
	await settle();
	assert.deepEqual(calls.stops, ["CDM"]);
	assert.deepEqual(calls.verbose, [
		{ channelId: "CDM", action: "on" },
		{ channelId: "CDM", action: "status" },
	]);
});

test("slash: refused in a passthrough channel and outside the allowed-channel filter", async () => {
	const { bot, calls, slash } = makeBot({
		channels: { CREL: { mode: "passthrough", url: "https://relay.example/hook" }, CDM: { mode: "dm" } },
		isRunning: () => true,
	});
	const relayAck = slash({ command: "/stop", text: "", channel_id: "CREL" });
	await settle();
	assert.equal(calls.stops.length, 0);
	assert.equal(relayAck.count, 1);
	assert.match(relayAck.responses[0].text, /external endpoint/);

	bot.allowedChannels = new Set(["COTHER"]);
	const filteredAck = slash({ command: "/stop", text: "", channel_id: "CDM" });
	await settle();
	assert.equal(calls.stops.length, 0);
	assert.match(filteredAck.responses[0].text, /isn't enabled/);
});

test("slash: an unknown command acks with a hint and never dispatches", async () => {
	const { calls, slash } = makeBot({ channels: { CDM: { mode: "dm" } }, isRunning: () => true });
	const ack = slash({ command: "/deploy", text: "prod", channel_id: "CDM" });
	await settle();
	assert.equal(calls.events.length, 0);
	assert.equal(calls.stops.length, 0);
	assert.equal(ack.count, 1);
	assert.match(ack.responses[0].text, /Unknown command/);
});

test("slash: a malformed envelope is acked exactly once and ignored", async () => {
	const { calls, slash } = makeBot({ channels: { CDM: { mode: "dm" } } });
	const ack = slash({ text: "", channel_id: "CDM" }); // no command
	await settle();
	assert.equal(calls.events.length, 0);
	assert.equal(ack.count, 1);
});

test("mention: thread mode responds only inside registered session threads", async () => {
	const { bot, calls, mention, workingDir } = makeBot({
		channels: { CTH: { mode: "thread" } },
	});
	// Top-level mention: log-only
	mention({ text: "<@UBOT> top", channel: "CTH", user: "U1", ts: "1000.0001" });
	// Unregistered thread: log-only
	mention({ text: "<@UBOT> stray", channel: "CTH", user: "U1", ts: "1000.0002", thread_ts: "999.0001" });
	await settle();
	assert.equal(calls.events.length, 0);

	// Registered session thread: dispatched into the SESSION channel
	const session = createSession(workingDir, { originChannel: "CTH", originThreadTs: "999.0002" });
	mention({ text: "<@UBOT> in thread", channel: "CTH", user: "U1", ts: "1000.0003", thread_ts: "999.0002" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.channel, `SESSION-${session.sessionId}`);
	assert.equal(bot.sessionRoutes.get(`SESSION-${session.sessionId}`)?.threadTs, "999.0002");
});

test("mention: interactive-thread top-level mention creates a session", async () => {
	const { calls, mention, workingDir } = makeBot({
		channels: { CIT: { mode: "interactive-thread" } },
	});
	mention({ text: "<@UBOT> new task", channel: "CIT", user: "U1", ts: "1000.0007" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.match(calls.events[0].event.channel, /^SESSION-/);
	const sessions = loadSessions(workingDir);
	assert.equal(sessions.size, 1);
	const [, session] = sessions.entries().next().value;
	assert.equal(session.integrations.slack.originThreadTs, "1000.0007"); // ts anchors the thread
});

test("mention: queue bound posts a notice at 5 queued", async () => {
	const { bot, calls, mention } = makeBot({});
	const release = fillQueue(bot, "CFULL");
	mention({ text: "<@UBOT> overflow", channel: "CFULL", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.posted.length, 1);
	assert.match(calls.posted[0].text, /Too many messages queued/);
	release();
	await settle();
});

test("mention: pre-startup messages are logged but not dispatched", async () => {
	const { bot, calls, mention } = makeBot({});
	bot.startupTs = "2000.000000";
	mention({ text: "<@UBOT> old", channel: "C1", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.events.length, 0);
});

test("mention: acks exactly once even when the handler throws", async () => {
	const { bot, mention } = makeBot({});
	bot.store = { processAttachments: () => { throw new Error("boom"); } };
	const ack = mention({
		text: "<@UBOT> crash", channel: "C1", user: "U1", ts: "1000.0001",
		files: [{ name: "f.txt", url_private_download: "https://x/f" }],
	});
	await settle();
	assert.equal(ack.count, 1);
});

// ============================================================================
// Passthrough (LLM never runs; every shape forwarded; admin words forwarded)
// ============================================================================

function passthroughBot(extraChannelConfig = {}) {
	const made = makeBot({
		channels: {
			CPT: { mode: "passthrough", url: "https://relay.example/hook", ...extraChannelConfig },
		},
	});
	const fetches = [];
	made.fetchOk = () => {
		globalThis.fetch = async (url, opts) => {
			fetches.push({ url, body: JSON.parse(opts.body) });
			return { json: async () => ({ response: "pong" }) };
		};
	};
	made.fetchFail = () => {
		globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
	};
	made.fetches = fetches;
	return made;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.PASSTHROUGH_API_KEY; });

test("passthrough: mention is forwarded with default payload, reply posted in-thread", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot();
	made.fetchOk();
	const ack = made.mention({ text: "<@UBOT> hi bot", channel: "CPT", user: "U1", ts: "1700.0001" });
	await settle();
	assert.equal(made.calls.events.length, 0); // LLM never runs
	assert.equal(made.fetches.length, 1);
	assert.deepEqual(made.fetches[0].body, {
		text: "hi bot",
		user: "U1", // no users loaded → falls back to id
		sender_id: "slack_17000001",
	});
	assert.deepEqual(made.calls.threads, [{ channel: "CPT", threadTs: "1700.0001", text: "pong" }]);
	assert.equal(ack.count, 1);
});

test("passthrough: stop/compact/reset are forwarded, not swallowed", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot();
	made.fetchOk();
	made.mention({ text: "<@UBOT> stop", channel: "CPT", user: "U1", ts: "1700.0002" });
	await settle();
	assert.equal(made.calls.stops.length, 0);
	assert.equal(made.fetches.length, 1);
	assert.equal(made.fetches[0].body.text, "stop");
});

test("passthrough: every message shape is forwarded (top-level, thread reply, DM)", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot();
	made.fetchOk();
	made.message({ text: "top level", channel: "CPT", user: "U1", ts: "1700.0003" });
	made.message({ text: "thread reply", channel: "CPT", user: "U1", ts: "1700.0004", thread_ts: "1700.0003" });
	made.message({ text: "a dm", channel: "CPT", user: "U1", ts: "1700.0005", channel_type: "im" });
	await settle();
	assert.equal(made.fetches.length, 3);
	assert.equal(made.calls.events.length, 0);
});

test("passthrough: top-level honours requireMentionForTopLevel; replies/DMs still forwarded", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot({ requireMentionForTopLevel: true });
	made.fetchOk();
	made.message({ text: "top level", channel: "CPT", user: "U1", ts: "1700.0006" });
	made.message({ text: "reply", channel: "CPT", user: "U1", ts: "1700.0007", thread_ts: "1700.0006" });
	await settle();
	assert.equal(made.fetches.length, 1);
	assert.equal(made.fetches[0].body.text, "reply");
});

test("passthrough: custom payload template renders all placeholders", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot({
		payload: { message: "{{text}}", from: "{{user_id}}", chan: "{{channel}}", at: "{{ts}}" },
	});
	made.fetchOk();
	made.mention({ text: "<@UBOT> payload test", channel: "CPT", user: "U9", ts: "1700.0008" });
	await settle();
	assert.deepEqual(made.fetches[0].body, {
		message: "payload test",
		from: "U9",
		chan: "CPT",
		at: "1700.0008",
	});
});

test("passthrough: DM endpoint failure posts an error notice; channel traffic fails quietly", async () => {
	process.env.PASSTHROUGH_API_KEY = "pt-key";
	const made = passthroughBot();
	made.fetchFail();
	made.message({ text: "a dm", channel: "CPT", user: "U1", ts: "1700.0009", channel_type: "im" });
	made.message({ text: "channel msg", channel: "CPT", user: "U1", ts: "1700.0010" });
	await settle();
	const notices = made.calls.threads.filter((t) => /Bot unavailable/.test(t.text));
	assert.equal(notices.length, 1);
	assert.equal(notices[0].threadTs, "1700.0009");
});

test("passthrough: mode without url forwards nothing and never runs the LLM", async () => {
	const made = makeBot({ channels: { CPT: { mode: "passthrough" } } });
	let fetched = 0;
	globalThis.fetch = async () => { fetched++; return { json: async () => ({}) }; };
	made.mention({ text: "<@UBOT> hi", channel: "CPT", user: "U1", ts: "1700.0011" });
	made.message({ text: "plain", channel: "CPT", user: "U1", ts: "1700.0012" });
	await settle();
	assert.equal(fetched, 0);
	assert.equal(made.calls.events.length, 0);
});

// ============================================================================
// message path (DMs, channel chatter, subtypes, bot filtering)
// ============================================================================

test("message: DM dispatches an LLM run; channel chatter is log-only", async () => {
	const { calls, message } = makeBot({});
	message({ text: "hello dm", channel: "D1", user: "U1", ts: "1000.0001", channel_type: "im" });
	message({ text: "channel chatter", channel: "C1", user: "U1", ts: "1000.0002" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.type, "dm");
	assert.equal(calls.events[0].event.channel, "D1");
});

test("message: channel message containing the bot mention is skipped (app_mention owns it)", async () => {
	const { calls, message } = makeBot({});
	message({ text: "<@UBOT> hi", channel: "C1", user: "U1", ts: "1000.0003" });
	await settle();
	assert.equal(calls.events.length, 0);
});

test("message: DM admin commands run in dm mode too, not just admin mode", async () => {
	const { calls, message } = makeBot({
		channels: { DADM: { mode: "admin" } },
		isRunning: () => true,
	});
	message({ text: "stop", channel: "DADM", user: "U1", ts: "1000.0004", channel_type: "im" });
	message({ text: "stop", channel: "DPLAIN", user: "U1", ts: "1000.0005", channel_type: "im" });
	await settle();
	assert.deepEqual(calls.stops, ["DADM", "DPLAIN"]);
	assert.equal(calls.events.length, 0); // intercepted, dispatched nowhere
});

test("message: bare top-level admin commands run in dm/admin channels, but not in leads", async () => {
	const { calls, message } = makeBot({
		channels: { CADM: { mode: "admin" }, CLEADS: { mode: "leads" } },
		isRunning: () => true,
	});
	message({ text: "compact", channel: "CADM", user: "U1", ts: "1000.0004a" });
	message({ text: "compact", channel: "CPLAIN", user: "U1", ts: "1000.0004b" }); // dm mode, the default
	// leads: top-level traffic is third-party feeds (an email bot's "STOP" is an
	// unsubscribe keyword) — the word stays ordinary text and dispatches as chat.
	message({ text: "compact", channel: "CLEADS", user: "U1", ts: "1000.0004c" });
	await settle();
	assert.deepEqual(calls.compacts, ["CADM", "CPLAIN"]);
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.channel, "CLEADS");
});

test("message: a buried thread reply that isn't a mention or DM does not trigger admin commands", async () => {
	const { calls, message } = makeBot({
		channels: { CADM: { mode: "admin" } },
		isRunning: () => true,
	});
	message({ text: "stop", channel: "CADM", user: "U1", ts: "1000.0004c", thread_ts: "999.0001" });
	await settle();
	assert.equal(calls.stops.length, 0);
	assert.equal(calls.compacts.length, 0);
	assert.equal(calls.resets.length, 0);
	assert.equal(calls.events.length, 0); // ignored, not dispatched as chat either
});

test("message: edited messages and other subtypes are ignored", async () => {
	const { calls, message } = makeBot({});
	message({ text: "edited", channel: "D1", user: "U1", ts: "1000.0006", channel_type: "im", subtype: "message_changed" });
	message({ text: "joined", channel: "D1", user: "U1", ts: "1000.0007", channel_type: "im", subtype: "channel_join" });
	await settle();
	assert.equal(calls.events.length, 0);
});

test("message: bot messages are ignored outside leads mode", async () => {
	const { calls, message } = makeBot({});
	message({ text: "from a bot", channel: "C1", bot_id: "BOTHER", ts: "1000.0008" });
	message({ text: "own message", channel: "C1", user: "UBOT", ts: "1000.0009" });
	await settle();
	assert.equal(calls.events.length, 0);
});

// ============================================================================
// Leads mode
// ============================================================================

test("leads: top-level message fires without a mention; thread replies are log-only", async () => {
	const { calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	message({ text: "new lead!", channel: "CLD", user: "U1", ts: "1000.0010" });
	message({ text: "internal discussion", channel: "CLD", user: "U2", ts: "1000.0011", thread_ts: "1000.0010" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.text, "new lead!");
});

test("leads: integration bot messages fire; own bot messages are filtered", async () => {
	const { calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	message({ text: "n8n lead", channel: "CLD", bot_id: "BOTHER", ts: "1000.0012", subtype: "bot_message" });
	message({ text: "own reply", channel: "CLD", bot_id: "BBOT", ts: "1000.0013", subtype: "bot_message" });
	message({ text: "own user msg", channel: "CLD", user: "UBOT", ts: "1000.0014" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.text, "n8n lead");
});

test("leads: block-based messages extract full block text", async () => {
	const { calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	message({
		text: "short",
		channel: "CLD",
		bot_id: "BOTHER",
		ts: "1000.0015",
		subtype: "bot_message",
		blocks: [{ type: "section", text: { type: "mrkdwn", text: "Full lead details from the block payload" } }],
	});
	await settle();
	assert.equal(calls.events[0].event.text, "Full lead details from the block payload");
});

test("leads: email file messages extract subject and body", async () => {
	const { calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	message({
		channel: "CLD",
		bot_id: "BMAIL",
		ts: "1000.0016",
		subtype: "file_share",
		text: "",
		files: [{ filetype: "email", subject: "Enquiry", plain_text: "We want a demo." }],
	});
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.text, "Subject: Enquiry\nWe want a demo.");
});

test("leads: pre-startup messages ARE replayed (missed-message replay)", async () => {
	const { bot, calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	bot.startupTs = "2000.000000";
	message({ text: "missed lead", channel: "CLD", user: "U1", ts: "1000.0017" });
	await settle();
	assert.equal(calls.events.length, 1);
});

test("leads: queue overflow drops with no channel notice", async () => {
	const { bot, calls, message } = makeBot({ channels: { CLD: { mode: "leads" } } });
	const release = fillQueue(bot, "CLD");
	message({ text: "overflow lead", channel: "CLD", user: "U1", ts: "1000.0018" });
	await settle();
	assert.equal(calls.posted.length, 0); // never post into a leads feed
	release();
	await settle();
	assert.equal(calls.events.length, 0);
});

// ============================================================================
// Interactive-thread mode (message path)
// ============================================================================

test("interactive-thread: top-level human message opens a session", async () => {
	const { calls, message, workingDir } = makeBot({ channels: { CIT: { mode: "interactive-thread" } } });
	message({ text: "help me", channel: "CIT", user: "U1", ts: "1000.0019" });
	await settle();
	assert.equal(calls.events.length, 1);
	assert.match(calls.events[0].event.channel, /^SESSION-/);
	assert.equal(loadSessions(workingDir).size, 1);
});

test("interactive-thread: requireMentionForTopLevel gates top-level messages", async () => {
	const { calls, message } = makeBot({
		channels: { CIT: { mode: "interactive-thread", requireMentionForTopLevel: true } },
	});
	message({ text: "help me", channel: "CIT", user: "U1", ts: "1000.0020" });
	await settle();
	assert.equal(calls.events.length, 0);
});

test("interactive-thread: bot-posted thread openers are log-only; first human reply creates the session", async () => {
	const { calls, message, workingDir } = makeBot({ channels: { CIT: { mode: "interactive-thread" } } });
	message({ text: "skill-posted opener", channel: "CIT", bot_id: "BOTHER", ts: "1000.0021" });
	await settle();
	assert.equal(calls.events.length, 0);
	assert.equal(loadSessions(workingDir).size, 0);

	message({ text: "human reply", channel: "CIT", user: "U1", ts: "1000.0022", thread_ts: "1000.0021" });
	await settle();
	assert.equal(calls.events.length, 1);
	const sessions = loadSessions(workingDir);
	assert.equal(sessions.size, 1);
	const [, session] = sessions.entries().next().value;
	assert.equal(session.integrations.slack.originThreadTs, "1000.0021"); // anchored to the opener
});

test("interactive-thread: replies continue their session (no second session)", async () => {
	const { calls, message, workingDir } = makeBot({ channels: { CIT: { mode: "interactive-thread" } } });
	const session = createSession(workingDir, { originChannel: "CIT", originThreadTs: "900.0001" });
	message({ text: "first", channel: "CIT", user: "U1", ts: "1000.0023", thread_ts: "900.0001" });
	message({ text: "second", channel: "CIT", user: "U1", ts: "1000.0024", thread_ts: "900.0001" });
	await settle();
	assert.equal(calls.events.length, 2);
	assert.ok(calls.events.every((c) => c.event.channel === `SESSION-${session.sessionId}`));
	assert.equal(loadSessions(workingDir).size, 1);
});

// ============================================================================
// Events watcher surface (enqueueEvent)
// ============================================================================

test("enqueueEvent: dispatches with isEvent=true", async () => {
	const { bot, calls } = makeBot({});
	const ok = bot.enqueueEvent({ type: "mention", channel: "C1", user: "EVENT", text: "[EVENT:x.json:immediate:now] ping", ts: "1000.0025" });
	await settle();
	assert.equal(ok, true);
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].isEvent, true);
});

test("enqueueEvent: refuses passthrough channels", async () => {
	const { bot, calls } = makeBot({
		channels: { CPT: { mode: "passthrough", url: "https://relay.example/hook" } },
	});
	const ok = bot.enqueueEvent({ type: "mention", channel: "CPT", user: "EVENT", text: "scheduled", ts: "1000.0026" });
	await settle();
	assert.equal(ok, false);
	assert.equal(calls.events.length, 0);
});

test("enqueueEvent: returns false when the queue is full", async () => {
	const { bot } = makeBot({});
	const release = fillQueue(bot, "C1");
	const ok = bot.enqueueEvent({ type: "mention", channel: "C1", user: "EVENT", text: "overflow", ts: "1000.0027" });
	assert.equal(ok, false);
	release();
	await settle();
});

// ============================================================================
// Startup resume (interrupted-run re-dispatch)
// ============================================================================

function writeChannelLog(workingDir, channelId, entries) {
	const dir = resolveChannelDir(workingDir, channelId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n"));
}

// Recent, so the IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS staleness guard doesn't fire —
// these fixtures exercise the re-dispatch path, not the age cutoff.
const nowSecs = Date.now() / 1000;
const interruptedLog = [
	{ ts: nowSecs.toFixed(4), user: "U1", text: "please do the thing", isBot: false },
	{ ts: (nowSecs + 1).toFixed(4), user: "UBOT", text: "_Thinking ...", isBot: true },
];

// Epoch 100 — decades old, well past any sane cutoff.
const staleInterruptedLog = [
	{ ts: "100.0001", user: "U1", text: "please do the thing", isBot: false },
	{ ts: "100.0002", user: "UBOT", text: "_Thinking ...", isBot: true },
];

test("resume: interrupted run in a dm channel is re-dispatched", async () => {
	const { bot, calls, workingDir } = makeBot({});
	bot.channels.set("CDM", { id: "CDM", name: "general" });
	bot.webClient = { chat: { delete: async () => ({}) } };
	writeChannelLog(workingDir, "CDM", interruptedLog);
	await bot.resumeInterruptedRuns();
	await settle();
	assert.equal(calls.events.length, 1);
	assert.equal(calls.events[0].event.text, "please do the thing");
});

test("resume: a stale interrupted run is not re-dispatched, but its placeholders are cleaned up", async () => {
	const { bot, calls, workingDir } = makeBot({});
	bot.channels.set("CDM", { id: "CDM", name: "general" });
	const deleted = [];
	bot.webClient = {
		chat: {
			delete: async ({ ts }) => {
				deleted.push(ts);
				return {};
			},
		},
	};
	writeChannelLog(workingDir, "CDM", staleInterruptedLog);
	await bot.resumeInterruptedRuns();
	await settle();
	assert.equal(calls.events.length, 0, "stale run must not be re-dispatched");
	assert.deepEqual(deleted, ["100.0002"], "stale placeholder should still be deleted");
});

test("resume: the staleness cutoff is configurable via IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS", async () => {
	const { bot, calls, workingDir } = makeBot({});
	bot.channels.set("CDM", { id: "CDM", name: "general" });
	bot.webClient = { chat: { delete: async () => ({}) } };
	// Six hours old: skipped at the default 4h, resumed when the cutoff is raised to 8h.
	const sixHoursAgo = Date.now() / 1000 - 6 * 3600;
	writeChannelLog(workingDir, "CDM", [
		{ ts: sixHoursAgo.toFixed(4), user: "U1", text: "please do the thing", isBot: false },
		{ ts: (sixHoursAgo + 1).toFixed(4), user: "UBOT", text: "_Thinking ...", isBot: true },
	]);

	await bot.resumeInterruptedRuns();
	await settle();
	assert.equal(calls.events.length, 0, "6h-old run is past the 4h default");

	const prev = process.env.IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS;
	process.env.IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS = "8";
	try {
		await bot.resumeInterruptedRuns();
		await settle();
		assert.equal(calls.events.length, 1, "raising the cutoff to 8h resumes it");
	} finally {
		if (prev === undefined) delete process.env.IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS;
		else process.env.IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS = prev;
	}
});

test("resume: completed runs are not re-dispatched", async () => {
	const { bot, calls, workingDir } = makeBot({});
	bot.channels.set("CDM", { id: "CDM", name: "general" });
	bot.webClient = { chat: { delete: async () => ({}) } };
	writeChannelLog(workingDir, "CDM", [
		...interruptedLog,
		{ ts: "100.0003", user: "UBOT", text: "Done — here's the result.", isBot: true },
	]);
	await bot.resumeInterruptedRuns();
	await settle();
	assert.equal(calls.events.length, 0);
});

test("resume: thread/interactive-thread/passthrough channels are skipped", async () => {
	const { bot, calls, workingDir } = makeBot({
		channels: {
			CTH: { mode: "thread" },
			CIT: { mode: "interactive-thread" },
			CPT: { mode: "passthrough", url: "https://relay.example/hook" },
		},
	});
	bot.webClient = { chat: { delete: async () => ({}) } };
	for (const id of ["CTH", "CIT", "CPT"]) {
		bot.channels.set(id, { id, name: id.toLowerCase() });
		writeChannelLog(workingDir, id, interruptedLog);
	}
	await bot.resumeInterruptedRuns();
	await settle();
	assert.equal(calls.events.length, 0);
});
