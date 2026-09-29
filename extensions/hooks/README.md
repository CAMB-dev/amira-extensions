# hooks

Your own commands on Amira's events: a formatter or linter after each edit, a guard before
risky shell commands, tests after a turn, something at the start and end of a session.

```sh
amira ext install hooks
```

Needs an Amira whose extension API has `tool.call.after`, `notify`, `onExit` and
`runCommand`'s `stdin` (newer than 0.1.1).

## Where hooks live

- `~/.amira/settings.json`, under `extensions.hooks`: your own hooks, for every project.
- `<project>/.amira/hooks.json` (the same object at the top of the file), and
  `extensions.hooks` in the project's `.amira/settings.json` or `settings.local.json`: hooks
  that come with the project.

A project's hooks never run silently. The first time a session starts in the project, Amira
shows its hooks and asks whether they may run. Yes is remembered (in
`~/.amira/hooks-trust.json`) for these hooks exactly: when the project changes them, for
example after a pull, you are asked again. No keeps them off for the session. With nobody to
ask (print mode, rpc without a UI) they do not run, and a warning says so. `/hooks trust`
allows them, `/hooks untrust` stops them. Your own hooks always run.

```jsonc
// ~/.amira/settings.json
{
  "extensions": {
    "hooks": {
      "afterEdit": [
        { "name": "prettier", "files": ["*.{ts,tsx,js,json,md}"], "command": "npx prettier --write \"$AMIRA_FILE\"" },
        { "name": "ruff", "files": ["*.py"], "command": "ruff check --fix \"$AMIRA_FILE\"" }
      ],
      "beforeTool": [
        {
          "name": "no-force-push",
          "tools": ["bash", "powershell"],
          "match": { "command": "git push.*(--force|-f\\b)|rm -rf /" },
          "action": "block",
          "reason": "Force pushes and rm -rf / are not allowed"
        },
        { "name": "push", "tools": ["bash"], "match": { "command": "^git push" }, "action": "ask", "reason": "Pushing to the remote" }
      ],
      "afterTurn": [{ "name": "tests", "command": "bun test", "onlyAfterEdits": true, "timeoutMs": 300000 }],
      "sessionStart": [{ "command": "git fetch --quiet", "reasons": ["startup"] }],
      "sessionEnd": [{ "command": "echo done >> ~/amira-sessions.log" }]
    }
  }
}
```

## Events

| Event | Runs | Can |
|---|---|---|
| `sessionStart` | when a session starts (`reasons`: `startup`, `resume`, `clear`, `fork`; default all) | show its output |
| `beforeTool` | before a matching tool call, in any session (sub-agents too) | block the call, or ask you first |
| `afterEdit` | after a successful `edit` or `write` (or `tools`) of a file matching `files` | send its output to the model |
| `afterTurn` | when a turn of the main session ends (`on`: `done`, `error`, `aborted`; default `done`) | show its output |
| `sessionEnd` | when Amira exits | (runs within the few seconds Amira waits at exit) |

Every hook may set:

- `command`: a command line, run by `bash` (Git Bash on Windows, as the bash tool uses; with
  PowerShell as the fallback) or by PowerShell with `"shell": "powershell"`;
- `name`: shown in notices and `/hooks`; by default the program's name;
- `timeoutMs`: default 60000 (`extensions.hooks.timeoutMs` changes the default), at most 30
  minutes. A hook that runs longer is killed with everything it started;
- `cwd`: relative to the project; default the project directory;
- `env`: extra variables;
- `disabled: true` to keep an entry without running it.

A hook gets these variables: `AMIRA_EVENT`, `AMIRA_HOOK`, `AMIRA_PROJECT_DIR`,
`AMIRA_SESSION_ID`, and by event `AMIRA_TOOL`, `AMIRA_TOOL_CALL_ID`, `AMIRA_FILE` (absolute
path), `AMIRA_TURN_END` (`done`, `error`, `aborted`), `AMIRA_SESSION_START`. On stdin it gets
one line of JSON with the same facts: `event`, `hook`, `projectDir`, `sessionId`, and `tool`,
`toolCallId`, `args` (before tool), `file` (after edit), `turn` (after turn), `reason`
(session start). PowerShell reads them as `$env:AMIRA_FILE`.

### After edit

`files` are globs; one without a slash (`*.ts`) matches the file's name in any directory, one
with a slash (`src/**/*.ts`) the path in the project. No `files` means every file. `tools`
defaults to `["edit", "write"]`. Matching hooks run one after another, before the model sees
the edit's result.

`feedback` decides whether the model reads the hook's output along with the edit's result:
`"onError"` (the default: when the hook fails, e.g. a linter's complaints), `"always"`, or
`"never"`. You see each run as a one-line notice under the call; a failure shows its last
lines, and whether it went to the model.

A formatter changes the file after the edit, so the model's copy is out of date; that is
usually fine, since the model reads a file again before editing it.

### Before tool

`tools` are names or globs (`"*"`, `"mcp_*"`; default every tool). `match` maps argument
names to regular expressions, all of which must match (`"*"` matches the arguments as JSON;
`"ignoreCase": true` for case-insensitive ones). A matching hook either:

- has an `action`: `"block"` refuses the call and tells the model the `reason`; `"ask"` asks
  you first (in the usual dialog, whichever agent made the call), and no, or nobody to ask,
  refuses it;
- or runs a `command`: exit code 2 refuses the call, with the command's output as the reason;
  exit code 0 lets it through, unless the output is a JSON object such as
  `{"decision": "block" | "ask" | "allow", "reason": "..."}`. A command that fails otherwise or
  times out lets the call through and shows a warning.

### After turn

Runs in the background after the main session's turn, one hook after another; a hook still
running from the turn before is not started again. `onlyAfterEdits: true` runs it only after
turns in which a file was edited or written (by any agent). Its output is shown to you, not
sent to the model.

## Options

Only your own settings can set these (a project cannot turn hooks on or trust itself):

```jsonc
"extensions": {
  "hooks": {
    "enabled": true,             // false turns every hook off
    "trustedProjects": ["D:/work"], // these directories (and below) run their hooks without asking
    "showSuccess": true,         // a notice for hooks that went well too
    "maxOutputChars": 4000,      // output kept per run: its start and its end
    "timeoutMs": 60000           // for hooks that set none
  }
}
```

## /hooks

- `/hooks`: the hooks by event, whether the project's are trusted, and the latest runs;
- `/hooks runs`: recent runs with their output (a full-screen view in the TUI);
- `/hooks trust`, `/hooks untrust`: allow or stop this project's hooks;
- `/hooks reload`: read the files again;
- `/hooks off`, `/hooks on`: for this session.

While hooks run, the status bar names them.

## Tests

```sh
bun install
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun run check                                    # tsc, biome, bun test
```

The tests run real commands through bash (Git Bash on Windows).
