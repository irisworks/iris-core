# Roadmap ideas

Not commitments, not sequenced — just things worth discussing. See
[discussion #122](https://github.com/irisworks/iris-core/discussions/122) for
the original writeup and any thread.

## Lowering the barrier to trying Iris

- **A "try it on Telegram in 5 minutes" path.** Bootstrap already supports
  Telegram end-to-end, and creating a bot via `@BotFather` is way less
  friction than a Slack app (scopes, socket mode, two tokens). Lead with
  Telegram for first-time tire-kickers; keep Slack as the recommended path
  for teams/production.

- **A one-click cloud image or cloud-init snippet.** "Get a Linux box" is
  still a step before `curl | bash`. A DigitalOcean/Hetzner marketplace
  image, or a cloud-init snippet droppable into any provider's VM creation
  flow, could collapse that further.

- **A skill gallery / community-skills repo.** Skills are plain directories
  that Iris hot-reloads — no build step, no registry. Feels like it wants to
  be an ecosystem (a bit like publishing an npm package), but there's
  currently no way to discover or share a skill someone else wrote.

- **A comparison page.** "Iris vs. running Claude Code in a cron job vs.
  LangChain-style agent frameworks vs. OpenClippy-style chat bots."
  Self-hosters comparison-shop before committing; nothing today helps them
  place Iris relative to the alternatives.
