# The reporter mod

`podium-reporter` is the Claude Code mod that sends a session's data to the Podium server. This covers
installing it, its options, everything that leaves a session, and how to report sessions that were started
without it. To run the server, see [SERVER.md](SERVER.md).

## Install the mod

The reporter is a Claude Code mod in `mod/podium-reporter/`. Install it from the eengelking
marketplace, in Claude Code:

```
/plugin marketplace add eengelking/skills
/plugin install podium-reporter@eengelking-marketplace
```

If the server uses a token (`podiumctl start` generates one), enter it with
`/plugin configure podium-reporter@eengelking-marketplace`. On your own machine that is the admin secret
(`podiumctl token`). If someone runs the server for a group, they make you a token in Admin: enter it as
`token`, and your name as `userName`. The token option is secret, so it has no row in the `/config` menu.
Without a token the server accepts, or with a token that does not belong to your name, the reporter gets
HTTP 401, logs it once, and tries again about once a minute. `/podium` and the status line say so.

To work on the mod itself, load it from a checkout for one session instead:

```sh
claude --plugin-dir /path/to/podium/mod/podium-reporter
```

The session appears in Podium once you send its first prompt. A session that has done nothing yet is kept
off the wall, because Claude Code's background daemon also runs idle twins and spares that report too (see
"Sessions that have not done anything yet" in [USER_GUIDE.md](USER_GUIDE.md)).
In the session, `/podium` prints the dashboard link, the connection state and report counts, and
`/podium name <text>` gives the session a display name. The status line under the prompt reads
`podium vX.Y.Z ● N live` (N is the cards on the wall, so a session that has not run yet reads 0), or `podium vX.Y.Z ○ offline` while the server is unreachable (reports queue up and go out
when it is back). When the mod and the server are on versions that do not match, it ends in `· update mod` or `· upgrade server`, and in `· update available` when the server supports a newer mod than yours. To update the mod, run `claude plugin marketplace update eengelking-marketplace && claude plugin update podium-reporter@eengelking-marketplace` in a shell and then `/reload-plugins` in the session (see "Updating the mod" in [USER_GUIDE.md](USER_GUIDE.md)). Claude Code puts a `⚠` and the mod's name in front of the line; that is how it draws every
mod's status line, not a Podium warning (see [GOTCHAS.md](GOTCHAS.md)). Effort is read from each model request, so a change made with `/effort` shows after
the session's next prompt, not when you pick it.

Set the mod's options with `/plugin configure podium-reporter@eengelking-marketplace`, or in
`~/.claude/settings.json` under `pluginConfigs`, `podium-reporter@eengelking-marketplace`, `options`
(`podium-reporter` for a copy loaded with `--plugin-dir`). Claude Code keeps `token` in its secure storage
instead. Everything except `token` also has a row in the `/config` menu.

| Option | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:4317` | Where reports go |
| `token` | empty | Sent as `X-Podium-Token`: a per-person token from Admin, or the admin secret (`PODIUM_TOKEN`) on a one-person setup |
| `userName` | empty | The name your token was made for. The server accepts a report only when the token and this name match. Leave empty when you report with the admin secret. Nothing that names you or your machine is sent until you set it; with it set, reports also carry this machine's name (see below) |
| `flushIntervalMs` | `1000` | Minimum time between reports while something changes |
| `heartbeatMs` | `5000` | Report at least this often |
| `sessionName` | empty | Display name override |
| `showStatus` | `true` | Show the status line entry |
| `fullPrompts` | `false` | Send each agent's whole task prompt and final answer (up to 20,000 characters each, secrets redacted) so the console can open them in a modal. Off by default: only the first 400 characters leave the session. Everyone who can open the console can read them |
| `activityFeed` | `false` | Send an agent's recent activity: while someone has that agent's panel open in the console, its last 20 tool calls (the tool's name and a short summary of its arguments) and the text it writes between them, each cut to 300 characters with secrets redacted. Nothing is sent for an agent nobody is watching, and the server keeps it in memory only. The orchestrator's own loop works the same way. Everyone who can open the console can watch. The server's Admin can also switch the feed off for everyone under Admin > Settings > Feature flags (on by default); while it is off the server asks no mod for it |
| `respond` | `off` | Respond from Podium: what this session accepts from Podium, sent by its owner or an Admin. `off` (nothing), `questions` (answers to questions, and new messages while idle), `questions-and-plans` (the above, plus approving or rejecting a plan), `everything` (the above, plus allowing or denying a tool, allow once only, and `/clear`, `/compact`). It needs `activityFeed` on too, and the server's Respond from Podium switch in Admin > Settings > Feature flags (off by default) |
| `explainFailures` | `false` | Ask a small model (Haiku, low effort) for a two-sentence explanation of each failed agent, from the redacted failure record only. Costs a little; off by default |

## What leaves the session

Only to the server URL above, and only this:

- the session's id, working directory, repository name, git branch and counts (ahead, behind, modified),
  model, effort, context fill, cost, token counts (also totalled per model, and per model for each agent, so
  the server can price them) and rate-limit percentages;
- the paths of the files the session changed in its repository, each with its status and its added and
  removed line counts (at most 200 files; never file contents or diff text);
- the plan's step titles (from TaskCreate, TaskUpdate or TodoWrite; a session that does not use these tools
  shows "No plan reported. Agents were launched ad hoc.", and plan mode does not make a plan appear, see
  [Gotchas](GOTCHAS.md#a-session-shows-no-plan));
- for the orchestrator's own loop: how many model requests it made, the name of every tool it used with how
  many times, and the skills it loaded;
- per agent: type, description, model, effort, status, token counts, skills it loaded, the name of every
  tool it used with how many times, the first 400 characters of its task prompt and of its final answer, or the whole of each (up to 20,000
  characters) only when you have turned on `fullPrompts`;
- for a failed call: the tool, a one-line summary of the call (a Bash command, or a tool and a file
  path), its exit code and the last 12 lines of its output;
- when a session is idle on background work or a scheduled wake-up: each task's type (shell, agent, monitor, workflow, wake-up), a short description of at most 120 characters, its status and when the wake-up fires. A shell's command is never sent;
- short activity lines ("spawned Explore (Haiku low): Map call sites");
- whether `activityFeed` is on, and only when you have turned it on, the server's Admin has not turned the
  feed off, and someone is watching an agent's (or the orchestrator's) panel right now: that loop's last 20 tool calls, each the tool's name and a short
  summary of its arguments (a Bash command, a file path, a search pattern), and the text the model wrote
  between them, each cut to 300 characters. The model's thinking is never sent. When nobody is watching,
  nothing of it is read or sent, and the server forgets it soon after the panel closes;
- only when you have set `respond` (and `activityFeed`), and the server takes answers: what the session accepts, and
  while it waits on you, the open question (its questions, options and previews), plan (its text and file path) or
  tool call (the tool and its arguments), each cut to fixed limits and redacted, so its owner can answer from the
  console. It is shown only to the session's owner or an Admin, and the server keeps it in memory only. After a
  `/clear`, the new session also names the one it continues, so History can link them;
- only when you have set `userName`: that name, and which machine the session runs on: its short host name
  (what `hostname` prints, up to the first dot) and a random 12-character id the mod makes the first time
  and keeps in one file (`~/.claude/podium-machine-id`, or under `CLAUDE_CONFIG_DIR` when that is set), so two
  machines with the same host name stay apart and every copy of the mod on a machine reports the same id. The id is random, not read from the hardware, and the
  operating system user name and `git config` are never read.

Before anything is sent, text is cut to those limits and anything that looks like a secret is replaced
with `[redacted]`: `sk-ant-...` keys, `ghp_...` tokens, `AKIA...` keys, `Bearer ...` values, and the
values after `password=`, `token=`, `secret=`, `apikey=` and `api_key=`. Podium never reads transcripts or
files, sends a whole prompt or answer only for `fullPrompts`, and sends what an agent is doing only for
`activityFeed`, while someone watches.

## Sessions without the mod

Claude Code's settings hooks can report a reduced view of sessions that were started without the mod:
the session, its working directory and model, agents by type, and waiting or ended states. They carry no
token counts, so context, cost and the plan stay empty, and Podium marks those sessions "settings hooks".
Add this to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SubagentStart":    [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/api/fleet/hook >/dev/null || true" }] }]
  }
}
```

Each hook posts the payload Claude Code gives it on stdin and always exits 0, so a stopped server never
gets in the session's way. When the server sets `PODIUM_TOKEN`, add `-H 'X-Podium-Token: <token>'`.

A session that the mod reports is never changed by hooks: the server acknowledges a hook for it and drops
it, so enabling both is harmless. Settings hooks send no heartbeat, so a hook-only session is allowed to
stay silent for `HOOK_STALE_AFTER_MS` (10 minutes) before it shows as stale. A finishing subagent does not
mark the session as waiting on you; the `Stop` hook does, unless it lists background work or a scheduled wake-up still in flight, in which case the session shows what it is waiting on instead (Podium reads the hook's `background_tasks` and `session_crons`, never a shell's command).
