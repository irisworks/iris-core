---
name: hi-agent
description: Says "hi" every 20 seconds for 1 minute by spawning immediate events
---

# hi-agent

Usage: `{baseDir}/run.sh`

Spawns 3 immediate "hi" events at 20-second intervals (20s, 40s, 60s) into the configured Telegram channel.
Runs in the background via nohup.
