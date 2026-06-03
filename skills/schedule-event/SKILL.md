---
name: schedule-event
description: Schedule an immediate, one-shot, interval, or recurring event for Iris to process. Always use this instead of writing event files directly — direct writes inside Firecracker go into the sandbox filesystem and are never seen by the host events watcher.
---

# Skill: schedule-event

Schedule an event by calling Iris's internal API. This writes the event file
directly to the host filesystem where the events watcher picks it up immediately.

**Always use this skill when you want to schedule anything. Never write event
files directly via bash or the write tool — those writes land inside the
Firecracker sandbox and are invisible to the host.**

---

## Choosing the right event type

| What you want | Event type |
|---|---|
| Do something right now | `immediate` |
| Do something once at a specific time | `one-shot` |
| Do N things spaced T seconds apart | `one-shot` × N with staggered `at` times |
| Repeat every T seconds/minutes (any interval) | `interval` |
| Repeat on a standard cron schedule (hourly, daily, etc.) | `periodic` |

**Key rule:** Never use a shell loop with `sleep` to create timed sequences.
Use `one-shot` events (for bounded N-times sequences) or `interval` events
(for ongoing repetition). Shell loops run inside the Firecracker sandbox and
their timing is lost once the agent run ends.

---

## Cost warning

Every event fire = one Claude API call. Think before setting short intervals:

| Interval | Fires per hour | Approx cost/hour |
|---|---|---|
| 10 seconds | up to 360 | ~$1.00 |
| 1 minute | up to 60 | ~$0.17 |
| 5 minutes | up to 12 | ~$0.03 |

The `interval` type has a built-in **skip-if-busy** guard: if the previous fire
is still processing, the next tick is skipped automatically — you won't double-pay.
Always use `count` or `endsAt` for bounded tasks.

---

## Channel IDs

- Telegram DM: `tg-{chatId}` (e.g. `tg-8814933356`)
- Telegram group topic: `tg-{chatId}-{threadId}`
- Slack channel: the Slack channel ID (e.g. `C01ABC123`)

---

## API endpoint

```
POST http://172.20.1.1:3000/internal/write-event
```

The host is always reachable at `172.20.1.1` from inside the Firecracker sandbox.

---

## Immediate event — fire right now

```bash
curl -s -X POST http://172.20.1.1:3000/internal/write-event \
  -H "Content-Type: application/json" \
  -d '{
    "name":      "check-status",
    "type":      "immediate",
    "channelId": "tg-8814933356",
    "text":      "Task instruction for Iris"
  }'
```

---

## One-shot event — fire once at a specific time

```bash
curl -s -X POST http://172.20.1.1:3000/internal/write-event \
  -H "Content-Type: application/json" \
  -d '{
    "name":      "remind-meeting",
    "type":      "one-shot",
    "channelId": "tg-8814933356",
    "text":      "Remind about the 3pm meeting",
    "at":        "2026-06-03T15:00:00Z"
  }'
```

`at` must be a future ISO 8601 timestamp. Events missed by less than 2 minutes
on restart will still fire; older ones are dropped.

### Timed sequence — N times, T seconds apart

Compute `at` values upfront and write N one-shot events:

```bash
BASE=$(date -u +%s)
for i in 1 2 3 4 5 6; do
  AT=$(date -u -d "@$((BASE + i * 10))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
       python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(seconds=$i*10)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  curl -s -X POST http://172.20.1.1:3000/internal/write-event \
    -H "Content-Type: application/json" \
    -d "{
      \"name\":      \"hi-$i\",
      \"type\":      \"one-shot\",
      \"channelId\": \"tg-8814933356\",
      \"text\":      \"Say hi (greeting $i of 6)\",
      \"at\":        \"$AT\"
    }"
done
```

Each event waits for its exact scheduled moment — the 10-second gaps are
preserved even if earlier agent runs are still in progress.

---

## Interval event — repeat every N seconds (any interval)

```bash
curl -s -X POST http://172.20.1.1:3000/internal/write-event \
  -H "Content-Type: application/json" \
  -d '{
    "name":           "status-ping",
    "type":           "interval",
    "channelId":      "tg-8814933356",
    "text":           "Check system status and report",
    "intervalSeconds": 30,
    "count":          10
  }'
```

**Fields:**
- `intervalSeconds` — required, minimum 5 (enforced automatically)
- `count` — optional, self-deletes after N fires
- `endsAt` — optional, self-deletes when this ISO 8601 timestamp passes

**Stop an interval:** delete its event file from
`/iris/data/telegram/events/` (or `/iris/data/slack/events/`).

**Skip-if-busy:** if the previous fire hasn't finished processing yet, the
next tick is automatically skipped. At most one in-flight agent call per
interval file at any time.

Examples:

```bash
# Run every 10 seconds, 6 times
"intervalSeconds": 10, "count": 6

# Run every minute until 9pm
"intervalSeconds": 60, "endsAt": "2026-06-03T21:00:00Z"

# Run every 30 seconds indefinitely (until file is deleted)
"intervalSeconds": 30
```

---

## Periodic event — standard cron schedule (hourly, daily, weekly)

```bash
curl -s -X POST http://172.20.1.1:3000/internal/write-event \
  -H "Content-Type: application/json" \
  -d '{
    "name":      "daily-summary",
    "type":      "periodic",
    "channelId": "tg-8814933356",
    "text":      "Send daily summary",
    "schedule":  "0 9 * * *",
    "timezone":  "Asia/Kolkata"
  }'
```

### Common cron schedules

| Schedule       | Meaning               |
|----------------|-----------------------|
| `* * * * *`    | Every minute          |
| `*/5 * * * *`  | Every 5 minutes       |
| `0 * * * *`    | Every hour            |
| `0 9 * * *`    | Every day at 09:00    |
| `0 9 * * 1`    | Every Monday at 09:00 |

Use `periodic` for standard calendar-based schedules. For anything sub-minute
or driven by duration/count, use `interval` instead.

Periodic events persist until manually deleted. To cancel, delete the event
file from `/iris/data/telegram/events/` or `/iris/data/slack/events/`.

---

## Notes

- `name` becomes the filename prefix — use something descriptive
- `immediate` and `one-shot` events self-delete after firing
- `interval` and `periodic` events persist until their termination condition
  (`count`, `endsAt`) is met or the file is manually deleted
- If Iris restarts, `interval` timers restart from the current time (a brief
  gap is acceptable); `one-shot` events missed by less than 2 minutes still fire
