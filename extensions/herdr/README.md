# herdr

Makes Amira a first-class agent in [herdr](https://github.com/herdrdev/herdr), the terminal
workspace manager for coding agents. Without it herdr shows Amira as `unknown`, and
`herdr agent wait` or `herdr agent prompt --wait` never see a state change. With it herdr
shows `amira` as working, idle or blocked, notifies you when it finishes or needs a
decision, and reopens the same session in the same pane after a herdr restart.

```sh
amira ext install herdr
```

It uses herdr's own [agent self-report protocol](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/add-herdr-support.mdx):
once Amira reports, herdr trusts the reports and stops reading the screen. Resume commands
need herdr 0.9.2 or later; older versions ignore them and the state still works.

## When it is active

Only inside a herdr pane: `HERDR_ENV=1` and non-empty `HERDR_PANE_ID` and `HERDR_BIN_PATH`.
Anywhere else it does nothing at all. `"extensions": { "herdr": { "enabled": false } }` in
settings.json turns it off.

An Amira started from inside another one (from the bash tool, say) runs in the same pane and
would fight over it: the outer one sets `AMIRA_HERDR_PANE` to the pane id for everything it
starts, and an Amira that finds its own pane id there stays silent.

## What herdr sees

Reports are for the main session only; sub-agents never report on their own.

| Amira                                                                        | herdr                                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A turn runs                                                                  | `working`                                                                                      |
| A question or approval waits for you, from the main session or any sub-agent | `blocked`, with the question (one line, at most 80 characters)                                 |
| Waiting for your input                                                       | `idle`                                                                                         |
| A turn failed                                                                | `idle`: Amira waits for input, and `blocked` would read "needs a decision" until the next turn |

Why sub-agents' dialogs count: when a sub-agent needs a permission, only that sub-agent's
session goes `blocked`. Its approval goes straight to the user (the approver handed down
from the main session), so the main session's own status stays `working` (or `idle`, for
a background sub-agent). The extension therefore also follows `ui.request` and
`ui.resolved`, and shows `blocked` while a dialog of any session other than the main one
is open: a sub-agent's approval carries that sub-agent's session id. Dialogs you open
yourself (the `/model` picker, other commands' and extensions' pickers) belong to the host,
and the main session's own approvals already show through its status, so neither of them
counts. Every other dialog does: a sub-agent's, and one from an extension's own background
conversation (a parentless session of its own), which needs you just the same. A new main
session (startup, `/clear`, `/resume`, a fork) forgets the dialogs of the one before.

## Resume after a herdr restart

Each new session (at startup, and after `/clear`, `/resume` or a fork) is reported with
`--agent-session-id` and the command that reopens it:

```sh
amira --resume <session id> --model <provider/model>
```

`--model` is there because `--resume` alone does not always keep the session's model:
Amira takes the model from `--model` (or `$AMIRA_MODEL`), then from `"model"` in
settings.json, and only then from the stored session. With `--model` the reopened session
runs on the model it last used. A model change (`/model`) reports the command again.
Without a model selected the flag is left out. Other options (permission mode, thinking
level) are not reported: no event says what they are.

herdr refuses a command whose first word is a path, which has an apostrophe or a control
character in an argument, or with more than 64 arguments or 8 KiB. Such a command is left
out and the state is reported without it.

A `/clear` or `/resume` replaces the session in the same process: that is reported as the
new session, not as a release. Quitting Amira (or a fatal error) releases the pane, once,
waiting at most a second for herdr to answer.

## Out of the way

Reports run `"$HERDR_BIN_PATH" pane report-agent …` through Amira's `runCommand`, in the
background, one at a time, each killed after 2 s. While one runs only the newest state
waits; older ones are dropped. `--seq` is the time in microseconds, kept strictly
increasing, so it also grows across restarts. A failed report is ignored silently (herdr
then falls back to reading the screen); a session that did not get through goes with the
next report, and a state that did not get through is sent again with the next event.

## Development

```sh
bun install
bun run link-amira <path to an Amira checkout>   # @amira/api types for tsc
bun test
bun run typecheck
bun run lint
```

The tests use a fake extension API and a fake `runCommand`: no herdr, no real home
directory.
