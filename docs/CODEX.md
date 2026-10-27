---
title: "Codex sessions"
description: "Show Codex sessions on the Podium wall: what the sidecar reads and posts, how to turn it on and off, and what a Codex card shows."
group: Running it
---

# Codex sessions

Podium can show the Codex sessions on your machine next to your Claude Code ones. A small sidecar follows the files Codex
already writes and reports each session to your local Podium server. It is off until you turn it on, it needs no change to
Codex or cmux, and nothing leaves the machine.

Contents:

- [What you see](#what-you-see)
- [What it reads and sends](#what-it-reads-and-sends)
- [Turn it on](#turn-it-on)
- [Turn it off](#turn-it-off)
- [Settings](#settings)
- [Limits](#limits)

## What you see

- A Codex session someone sits in is one card. It is named after its cmux tab (the same tab naming as
  [`PODIUM_CMUX_NAMES`](SERVER.md#server-settings)), else Codex's own name for the thread, else the folder. It carries a
  `codex` badge, and the **Codex** filter tab lists only these cards. It shows running while a turn is open and idle between turns.
- Headless `codex exec` runs, which other tabs launch by the dozen, do not get a card each. Every run one tab launched is folded into
  one card named `<tab> · codex runs`. Its note says how many are running, how many finished in the last day, and the latest one's folder
  and time.
- A card shows the model, how full the context is, and token counts. A model Podium has no price for shows no cost.
- Codex cards add nothing to the activity feed.

## What it reads and sends

The sidecar reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/session_index.jsonl`, and, for the tab names,
cmux's `~/.cmuxterm/codex-hook-sessions.json` and `cmux workspace list`. From a rollout it keeps only ids, the folder, how the session
was started, the model, turn start and end, and token counts. It never keeps a prompt, a response, an instruction or a tool call.
Each card is posted to `PODIUM_URL/api/fleet/report` with your token in the `X-Podium-Token` header, as the reporter mod does. The token is
never logged.

A session cmux's hook file does not list is matched to its tab from its process: the sidecar finds the Codex process that started within
30 seconds of the session and reads only its `CMUX_WORKSPACE_ID` variable. It tries three times a minute apart, then uses the thread name.

## Turn it on

1. Build the server: `podiumctl build --mode standalone` (this makes `server/dist/codex/sidecar.js`).
2. Try it in a terminal first: `PODIUM_CODEX=1 node server/dist/codex/sidecar.js`. The cards appear on the wall within about 30 seconds.
   Stop it with Ctrl-C.
3. To keep it running, copy `docs/launchd/dev.podium.codex.plist` to `~/Library/LaunchAgents/`, put the path of your checkout in it, and
   run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.podium.codex.plist`. Its log is `/tmp/podium-codex.log`.

## Turn it off

`launchctl bootout gui/$(id -u)/dev.podium.codex`, and delete the plist. The cards leave the wall about a minute after the last report.

## Settings

The sidecar reads these from its environment (the plist sets `PODIUM_CODEX`). The token and port also come from `~/.podium/config.env`
when the environment does not set them.

| Variable | Default | What it does |
|---|---|---|
| `PODIUM_CODEX` | off | `1` or `true` lets the sidecar run. Without it the program exits at once. |
| `PODIUM_URL` | `http://127.0.0.1:<port>` | Where to post. The port is `PODIUMCTL_PORT`, else 4317. |
| `PODIUM_TOKEN` | from `config.env` | Sent as `X-Podium-Token`. |
| `PODIUM_USER` | none | The person to report as, when the server uses named tokens. |
| `PODIUM_CODEX_DIR` | `~/.codex/sessions` | Where the rollout files are. |
| `PODIUM_CMUX_BIN` | the cmux app's binary | The `cmux` command used for tab titles. |

## Limits

- A session with no record for 24 hours leaves the wall, even if its process is still open.
- Work is bounded: at most 200 files followed, 8 MiB read per five-second pass, and a big file is read from its start and its last 512 KiB
  the first time it is seen, so a turn that started before that tail and is still open is shown idle.
- Permission prompts in Codex are not shown: a Codex card is running or idle.
- A server that does not answer, or refuses the token, pauses the sidecar for a minute; each is logged once (`codex_sidecar.server_unreachable`,
  `codex_sidecar.token_refused`). A report the server refuses is logged with its session and status (`codex_sidecar.report_refused`).
