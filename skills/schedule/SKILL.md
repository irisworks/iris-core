---
name: schedule
description: Create, list, and cancel reminders and recurring tasks via Iris's events queue. Use when asked to "remind me", "every morning", "at 5pm", or any scheduled/recurring request.
---

# Skill: schedule

Schedule future or recurring messages to a channel using Iris's built-in events
queue. When an event fires, its `text` arrives in the channel as if a user sent
it — so write the text as an instruction to your future self
(e.g. `"post a standup reminder"`), not as the final message.

No external services: events are JSON files in `$IRIS_EVENTS_DIR`
(default `/iris/data/events`), hot-watched by the runtime.

## Usage

```bash
# One-shot: fire once at an ISO 8601 time (with timezone offset)
schedule once --channel <channelId> --at "2026-07-20T17:00:00+05:30" --text "remind the team about the release call"

# Recurring: cron schedule + IANA timezone (default UTC)
schedule every --channel <channelId> --cron "0 9 * * 1-5" --tz "Asia/Kolkata" --text "post the morning summary"

# List scheduled events
schedule list

# Cancel by id (the filename shown by `schedule list`)
schedule cancel schedule-1752940000-a1b2.json
```

Use the channel ID of the current conversation unless the user names another
channel. Never hardcode channel IDs in skills or docs.

## How it works

The script writes an event file the runtime's `EventsWatcher`
(`iris-runtime/src/engine/events.ts`) picks up:

- `one-shot` — `{"type":"one-shot","channelId":...,"text":...,"at":"<ISO 8601>"}`;
  the file is deleted automatically after it fires.
- `periodic` — `{"type":"periodic","channelId":...,"text":...,"schedule":"<cron>","timezone":"<IANA>"}`;
  the file persists and fires on every cron match. Deleting the file cancels it.

## Notes

- `--at` must include a timezone offset (`Z` or `+05:30`); times in the past are
  skipped by the runtime.
- Cron is standard 5-field syntax; `timezone` is required by the runtime for
  periodic events (the script defaults it to `UTC`).
- Editing an event file reschedules it; deleting it cancels it — `schedule cancel`
  is just a guarded delete.
- Requires `jq` (available on all Iris hosts).
