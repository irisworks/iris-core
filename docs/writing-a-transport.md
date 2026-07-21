---
title: Writing a Transport
description: The ChannelTransport contract — how to plug a new chat platform (Discord, WhatsApp, ...) into Iris with zero engine edits.
---

# Writing a Transport

"How do I add Discord/WhatsApp?" — implement `ChannelTransport`
(`src/transport/types.ts`) and register it in `main.ts`. The engine
(`src/engine/index.ts`, `agent.ts`) never imports a concrete transport; it
only knows the shapes in `transport/types.ts`. A correctly-implemented
transport requires **zero engine edits** — that's the acceptance bar, not an
aspiration.

Four things exist today: `SlackBot`, `TelegramBot`, `BridgeTransport`
(headless — sub-agents and the internal API), `WebTransport` (the built-in
browser UI, see [Web UI](web-ui.md)). Read `src/transports/bridge/bridge-transport.ts`
first — it's the smallest complete implementation and proof the interface
isn't Slack-shaped (posting is a no-op; replies accumulate for a session
request to consume instead of hitting a real API).

## The `ChannelTransport` interface

```ts
interface ChannelTransport {
	transportId: string;
	promptProfile: TransportPromptProfile;
	stopCommandHint: string;
	start(): Promise<void> | void;
	stop(): Promise<void> | void;
	ownsChannel(channelId: string): boolean;
	getChannels(): ChannelInfo[];
	getUsers(): UserInfo[];
	postMessage(channelId: string, text: string): Promise<string>;
	updateMessage(channelId: string, messageId: string, text: string): Promise<void>;
	enqueueEvent(event: TransportEvent): boolean;
	createContext(event: TransportEvent, state: ChannelState, isEvent?: boolean): MessageContext;
}
```

- **`transportId`** — a short lowercase tag (`"slack"`, `"telegram"`,
  `"bridge"`, `"web"`). Stamped onto every `MessageContext` this transport
  creates; `agent.ts` uses it to look up the prompt profile via
  `getPromptProfile(ctx.transportId)` and throws if none is registered — get
  this wrong and every run on the new transport fails at prompt-build time.
- **`ownsChannel(channelId)`** — how inbound API calls and synthetic events
  (`POST /sessions/:id/message`, scheduled events) find their transport. The
  registry in `main.ts` is checked in order (`transports.find(t =>
  t.ownsChannel(id))`), so ownership must be based on a channel-id shape that
  doesn't collide with another transport's — Telegram claims a `tg-` prefix,
  Bridge is the catch-all fallback ("everything that isn't Telegram"). If your
  new transport's channel IDs could collide with an existing prefix, pick a
  distinguishing prefix (`dc-` for Discord, `wa-` for WhatsApp) and register it
  before Bridge in the `main.ts` array (see [Registering it](#registering-it)).
- **`postMessage` / `updateMessage`** — send a new message and edit an
  existing one (by the ID `postMessage` returned). These back the "Thinking…"
  placeholder pattern every transport uses: post it, then edit it in place
  with the final reply's first chunk once the run completes.
- **`enqueueEvent`** — queue an inbound event for processing; returns `false`
  when the channel's queue is full (the caller logs a warning and drops the
  event — see [Queueing and overflow](channel-modes.md#queueing-and-overflow)
  for the shared 5-message-per-channel convention every transport follows).
  Own your queue: `BridgeTransport` has none (it dispatches synchronously),
  Slack/Telegram each keep a per-channel `ChannelQueue`.
- **`createContext`** — build the `MessageContext` (below) for one inbound
  event. This is where transport-specific reply plumbing (message chunking,
  thread anchoring, typing indicators) gets wired up.

## `MessageContext` — chunking and threading are the transport's job

```ts
interface MessageContext {
	transportId: string;
	message: { text, rawText, user, userName?, channel, ts, attachments };
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	getAccumulatedText: () => string;
	onToolEvent?: (event: ToolEvent) => void;
}
```

The engine calls `respond`/`replaceMessage`/`respondInThread` with **whole,
unsplit text** — it never chunks, truncates, or otherwise looks at platform
message-length limits. That's entirely the transport's responsibility inside
`createContext`'s closures:

- Slack chunks at `SLACK_MAX_LENGTH`, splitting on natural newline boundaries
  (`splitIntoChunks` in `slack.ts`), posts chunk 1 in place of the "Thinking…"
  placeholder and chunks 2+ as thread replies, and re-splits at half the
  chunk size (down to a 1,000-char floor) if Slack still rejects a chunk with
  `msg_too_long` — budgeted against the *HTML-escaped* length, since that's
  what Slack enforces against.
- `TransportPromptProfile.maxMessageChars` is the number the *model* is told
  to target (so replies rarely need splitting at all) — the transport's own
  hard chunking logic is the backstop for when the model ignores that budget
  or a single tool result is unavoidably huge.
- `BridgeTransport` does no chunking at all: `respond` just concatenates into
  an in-memory accumulator (`getAccumulatedText()`), because the consumer
  (`POST /sessions/:id/message`) wants one string, not a platform-shaped
  sequence of posts.

Threading is the same story: `respondInThread` is "post a supplementary,
lower-priority detail" (errors, usage summaries) — Slack posts it as an
actual thread reply; a transport with no threading concept (Bridge, in
effect) can just fold it into the same accumulator. There's no shared
chunking/threading helper in the engine to call into — each transport owns
this because platform message-length limits and thread semantics are
genuinely platform-specific; don't try to hoist it up.

`onToolEvent` is optional and additive: transports that can render
live-updating structure (the web UI's tool cards) implement it to get the
raw `ToolEvent` instead of the flattened markdown string `respond(...)`
already receives for the same tool_execution_start/end moments. Slack and
Telegram don't implement it — mrkdwn/plain-text has nothing better to do
with structure than flatten it — and that's a legitimate, permanent choice,
not a gap to fill later.

## `TransportPromptProfile` — no platform text in the engine

```ts
interface TransportPromptProfile {
	transportId: string;
	identityLine: string;
	formattingSection: string;
	directorySection: (channels: ChannelInfo[], users: UserInfo[]) => string;
	silentNote: string;
	attachNote: string;
	attachmentsTagName: string;
	maxMessageChars: number;
}
```

`buildSystemPrompt` in `src/engine/agent.ts` composes the system prompt
entirely from these fields — `grep -ri discord src/engine/agent.ts` must
return nothing once your transport lands, same invariant IRIS-49 established
for Slack. Register the profile at construction time with
`registerPromptProfile(this.promptProfile)` (see `BridgeTransport`'s
constructor); the registry is a module-level `Map` keyed by `transportId`,
so construct the transport before any message on it can be dispatched.

Field-by-field, using Telegram's profile (`telegram.ts`) as the concrete
example:

- **`identityLine`** — one sentence: `"You are Iris, a Telegram-connected
  orchestrator for specialized sub-agents."`
- **`formattingSection`** — the platform's markup dialect, spelled out
  precisely enough the model doesn't guess wrong (Telegram's is a Markdown
  subset converted to HTML server-side; the profile explicitly calls out
  what does *not* convert — single `*asterisks*` — so the model doesn't use
  GitHub-flavored Markdown by habit. `[markdown](links)` are still
  discouraged in the prompt, but `toTelegramHtml()` handles them
  defensively either way: an `http(s)` URL becomes a real `<a href>`, and
  anything else — most commonly the model wrapping an attachment's filename
  in link syntax, since the file itself already went out separately via the
  `attach` tool — is reduced to plain label text instead of leaking raw
  `[text](url)` bracket syntax into the chat).
- **`directorySection(channels, users)`** — a function, not a static string,
  because it renders the live channel/user list into ID↔name mapping
  guidance for that run.
- **`silentNote`** / **`attachNote`** — what `[SILENT]` and the attach tool
  do on this platform, in prose the model conditions on.
- **`attachmentsTagName`** — the XML-ish tag wrapping non-image attachment
  paths in the user prompt (`telegram_attachments`, `slack_attachments`).
- **`maxMessageChars`** — see [chunking](#messagecontext--chunking-and-threading-are-the-transports-job)
  above.

## Registering it

`main.ts` constructs transports from env and pushes them into one array in
registry order — that order is also the fallback preference order for
session operations that don't already know which transport owns a channel
(Slack, then Telegram, then Bridge today):

```ts
const transports: (ChannelTransport & SessionInjector)[] = [];

const discordBot = DISCORD_BOT_TOKEN
	? new DiscordBot(handler, { token: DISCORD_BOT_TOKEN, workingDir })
	: null;
if (discordBot) transports.push(discordBot);
```

Gate construction on the presence of whatever credential the platform
needs, exactly like Slack/Telegram/the web UI do — a transport with no
token configured must cost the install nothing (no connection attempt, no
log noise), the same "off by default" contract `IRIS_WEBUI_PORT` follows.
`SessionInjector` (`injectSessionMessage` / `resetSessionContext`) is a
second, smaller interface required only if the transport should be reachable
via the internal session API (`api.ts`) — `BridgeTransport` implements it
because sub-agent escalation depends on it; a chat-only transport that never
backs a session can skip it.

**Caveat:** the "register before Bridge" rule above is not consistently
followed by the shipped transports today — `WebTransport` is pushed *after*
`BridgeTransport` in `main.ts` even though Bridge's `ownsChannel` is a
catch-all (`!channelId.startsWith("tg-")`) that also matches `WEBUI-*`
channel IDs. In practice this hasn't bitten Web because it never goes
through the shared `transports.find(t => t.ownsChannel(id))` lookup (its
messages travel over its own WebSocket connection, not the events-file
watcher or channel-addressed API routes) — but a channel-addressed API call
or synthetic event against a `WEBUI-*` channel would resolve to Bridge's
no-op `postMessage` instead of Web's real one. Don't copy Web's position in
the array as precedent; follow the stated rule (register before Bridge) and
verify with a synthetic event or a channel-addressed API call against your
new transport's channel IDs, not just a live chat message.

## Channel-mode dispatch is opt-in, not part of the contract

The six named [channel modes](channel-modes.md) (`dm`/`admin`/`thread`/
`interactive-thread`/`leads`/`passthrough`) and the `resolveDispatch()`
pipeline behind them (`src/engine/dispatch.ts`, `dispatch-config.ts`) are
expressed against fully generic shapes (`InboundMessage`, `DispatchConfig`)
specifically so any transport *can* drive them — but today only Slack does.
Telegram and the web UI have their own simpler event handling and don't read
`data/channels.json` at all. Implementing `ChannelTransport` does not require
wiring up channel-mode dispatch; do it only if the new platform genuinely
needs per-channel mode configuration (mention-gating, passthrough relay,
admin commands). If you do, drive it through `resolveDispatch` rather than
re-deriving the same trigger/container logic a second time — that
duplication is exactly the bug class IRIS-54 killed.

## Checklist before opening a PR

- [ ] `transportId` is stamped on every `MessageContext` this transport
      creates, and `registerPromptProfile` is called at construction time.
- [ ] `ownsChannel` can't collide with an existing transport's channel-ID
      shape; the new transport is pushed into `main.ts`'s array before
      Bridge (the catch-all fallback).
- [ ] No platform-specific string literals leak into `src/engine/agent.ts`
      or `src/engine/index.ts` — everything platform-flavored lives on
      `TransportPromptProfile` or inside this transport's own file.
- [ ] Message chunking and thread anchoring are implemented in
      `createContext`'s closures, budgeted against whatever length limit
      the platform actually enforces (escaped/rendered length, not raw).
- [ ] Attachments are saved via `resolveChannelDir`/`resolveChannelPath`
      (`src/engine/store.ts`) — never a hand-built `workingDir + channelId`
      path.
- [ ] Zero-config-cost when disabled: no token/port set means no connection
      attempt and no log noise.
- [ ] `iris-runtime/CHANGELOG.md` (`[Unreleased]`) and this docs page (or a
      new one, linked from `docs/meta.json`) are updated in the same PR —
      see the [PR review checklist](REVIEW_CHECKLIST.md).
