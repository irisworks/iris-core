---
name: upgrade-iris
description: Upgrade this Iris install to the latest (or a given) release tag. Refuses to start if the checkout has uncommitted or unpushed work, and runs detached so the iris.service restart doesn't kill the upgrade. Use when asked to "upgrade yourself", "update to the latest version", or to move to a specific release tag.
---

# Skill: upgrade-iris

Upgrades this install by running `scripts/upgrade.sh` — which checks out a
release tag, verifies its signature, rebuilds `iris-runtime`, and restarts
`iris.service`. This skill wraps that with the two things Iris needs to run it
on herself: a preflight that protects pending work, and detachment so the
restart doesn't kill the upgrade halfway through.

## Usage

```bash
upgrade-iris                  # upgrade to the latest release tag
upgrade-iris v1.4.1           # upgrade to a specific tag
upgrade-iris --check          # preflight only — report, change nothing
upgrade-iris --force          # upgrade even though pending work was found
```

Run `--check` first when asked whether an upgrade is possible. It answers that
question without touching anything.

## What the preflight blocks

`upgrade.sh` moves HEAD onto a release tag. The preflight refuses to start when
that would strand work this box is the only copy of:

- **Uncommitted changes to tracked files** — a tag checkout does not preserve
  them. Commit or discard first.
- **Commits not on any remote** — either ahead of the tracking branch, or, with
  no tracking branch, on no remote branch at all. These survive on their branch
  ref, but HEAD moves off them and nothing else has them.

Untracked files are reported, not blocked — a checkout leaves them alone.
When a check genuinely cannot run (not a git checkout, no HEAD), it warns and
continues rather than blocking on a question it couldn't answer.

`--force` proceeds anyway. The failure message prints the exact
`git -C <repo> checkout <branch>` needed to get back afterwards.

## Why detached

The upgrade restarts `iris.service` — the process running this skill. In the
foreground that means Iris is killed mid-command and never sees the outcome.
The work is handed to a transient `iris-upgrade` systemd unit (running as the
same user, in the same directory) that outlives the restart. Off systemd, it
detaches with `setsid` instead.

So **this command ending abruptly is success, not failure.** Output goes to
`/iris/upgrade.log` (previous run rotated to `.prev`), a fixed path that
survives the restart. Once back up, confirm with:

```bash
tail -40 /iris/upgrade.log
systemctl is-active iris
git -C /iris/repo describe --tags
```

## Notes

- Handles both install shapes from [overlay.md](../../docs/overlay.md): a
  pinned clone at `$IRIS_DIR/repo`, or an overlay repo with a `core/`
  submodule. Detection mirrors `upgrade.sh`'s own, so the repos it guards are
  exactly the ones the upgrade will move.
- Needs `sudo` for `systemd-run` and for the service restart inside
  `upgrade.sh`. On an install where sudo prompts for a password, run
  `upgrade.sh` from an operator shell instead — a detached unit has no
  terminal to prompt on.
- Env overrides: `IRIS_DIR` (default `/iris`), `IRIS_OVERLAY_DIR` (default the
  current directory).
