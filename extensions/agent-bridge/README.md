# agent-bridge

> **Experimental.** The commands, their options and the output format may still change.

Keeps one Amira session running for an external agent that can run shell commands but
cannot hold a process's stdin and stdout open. `amira agent start` launches a detached
bridge; later CLI calls send work, read progress, steer a turn, or answer an approval.
There is no GUI and no separate agent loop: the bridge holds an `amira --rpc` child and
uses Amira's existing session, tools, permissions, and event protocol.

```sh
amira ext install agent-bridge
amira agent start --cwd /path/to/project --json
```

Requires Amira extension API `^0.1.27`. Configure a model and its credentials in Amira,
or pass `--model provider/model`. A ready bridge does not guarantee that a later model
call has valid credentials.

## Commands

Every public command, including help, accepts `--json`. Options below use long names;
`-h` is also available for help. Quote text as one argument, or pass `-` to read it from
stdin. All calls use the same Amira home resolved by the public package-command API;
set `AMIRA_HOME` consistently if you use a nondefault home.

```text
amira agent start [--model ref] [--cwd dir] [--mode default|edits|auto|plan]
                  [--resume sessionId] [--idle minutes] [--name label] [--json]
amira agent send id text|- [--steer] [--json]
amira agent steer id text|- [--json]
amira agent read id [--since cursor] [--all|--last-turn] [--json]
amira agent wait id --until turn-end|reply|request|idle
                   [--since cursor] [--timeout seconds] [--json]
amira agent status id [--json]
amira agent respond id requestId value-json [--json]
amira agent abort id [--json]
amira agent stop id [--json]
amira agent list [--json]
amira agent --help [--json]
```

| Command | Behavior |
|---|---|
| `start` | Starts one detached bridge and one session. Returns only the bridge `id` and Amira `sessionId`, after the endpoint is bound, RPC reports the session, state/history are loaded, any rename succeeds, and an authenticated readiness probe succeeds. Startup failures include available RPC/startup stderr tails. |
| `send` | Starts a turn and returns its acceptance, not its final answer. A busy RPC returns `busy — use steer`. `--steer` uses the same operation as `steer`. |
| `steer` | Queues input for a running turn, or starts a turn when idle. It does not interrupt a tool already running. Watch steering events for `queued`, `injected`, `dropped`, or `promoted`; queued input during compaction may not yet have a turn ID. |
| `read` | Returns journal events strictly after `--since` and a snapshot of currently pending requests. `--all` reads session messages through RPC; `--last-turn` reads RPC's last-turn messages and available result metadata. Those history modes do not filter messages by `--since`. |
| `wait` | Waits for a condition and returns a read result since the supplied cursor, including on timeout. Defaults to 60 seconds; `--timeout 0` checks immediately. |
| `status` | Returns running/idle state, current tool and the full tools list in JSON, pending requests, subagents, model, usage/cost, cursor, and idle countdown. A paused countdown is `null` in JSON. |
| `respond` | Sends a JSON value to RPC `ui.respond`. An invalid answer leaves the request open; explicit `null` cancels it. |
| `abort` | Asks RPC to abort the current turn without stopping the bridge. |
| `stop` | Rejects new work, asks RPC to abort, closes its stdin, and applies bounded child-process-tree cleanup. Removes the endpoint and retains state, journal, and Amira session history. |
| `list` | Lists retained bridge metadata, including exited/failed bridges. Prunes stale endpoints by PID plus process-start identity, marking metadata exited rather than deleting history. It never kills a recycled PID; an unreadable identity is reported as unknown. |

`start` defaults to the command's working directory and `--mode default`. That mode
leaves Amira's permission mode unchanged; `edits`, `auto`, and `plan` pass through to
Amira's permission mode. Choose `auto` only when you intend Amira to act with that
permission policy. `--name` renames the session, not the bridge ID.

Wait conditions:

- `turn-end`: a root-session turn ends after the cursor, whether done, errored, or aborted.
- `reply`: a completed root assistant message containing text appears after the cursor.
  It need not be the final reply of the turn.
- `request`: at least one request is pending now, regardless of cursor.
- `idle`: no running work or pending request remains now, regardless of cursor.

Subagent replies and turn ends do not satisfy root `reply` or `turn-end` waits. UI
requests can come from the host and are not restricted to the root session. Conditions
already satisfied return immediately. Closing a wait client cancels only its wait; it
does not abort the session or answer its requests.

### JSON and exit codes

`--json` writes one JSON object to stdout, not a stream of JSON lines. Successful command
results are not wrapped in a common `ok` envelope. For example:

```json
{"id":"<bridge-id>","sessionId":"<amira-session-id>"}
```

Ordinary reads return `{ "events": [...], "cursor": 42, "pendingRequests": [...] }`.
Wait results also contain `until` and `timedOut`. Session-history reads contain
`messages` instead of `events`. `list` returns `{ "agents": [...] }`. Errors handled by
the command return `{ "error": "...", "exitCode": 1 }` with the applicable exit code;
without `--json`, errors go to stderr. Neither form prints the authentication token.

| Exit code | Meaning |
|---|---|
| `0` | Command succeeded, including a wait whose condition was met. A completed turn may still have reason `error` or `aborted`; inspect its result. |
| `1` | Invalid arguments, authentication or RPC error, startup failure, or another command failure. A missing/already-answered UI request is an RPC error, not code 3. |
| `2` | Wait timed out. Output still includes events, pending requests, and the cursor. The turn keeps running. |
| `3` | Bridge not found, not running, stopping, or unreachable. |

## External-agent example

This walkthrough uses a POSIX shell and `jq`; neither is a bridge dependency. Replace
`/path/to/project` and `provider/model`. Keep the two IDs separate: commands address the
bridge ID, while resume takes the Amira session ID. Check each command's exit code;
do not treat a successful send or wait as proof that the requested work succeeded.

Start and send a task from stdin:

```sh
started=$(amira agent start --cwd /path/to/project --model provider/model \
  --mode default --name "External review" --json) || exit $?
id=$(printf '%s' "$started" | jq -r '.id')
session=$(printf '%s' "$started" | jq -r '.sessionId')

sent=$(printf '%s\n' 'Inspect the project and add a focused regression test. Explain any approval you need.' \
  | amira agent send "$id" - --json) || exit $?
cursor=$(printf '%s' "$sent" | jq -r '.cursor')
```

The send result's cursor is captured **before** sending, so even a fast reply remains
visible. While work is running, inspect progress and steer it:

```sh
amira agent status "$id" --json
amira agent read "$id" --since "$cursor"
amira agent steer "$id" 'Keep production code unchanged; add only the regression test.' --json
```

Steer while status shows running to inject into that work. If the turn finishes first,
steering starts a new turn; it is not a conditional "only if still busy" operation.
Keep the original cursor here so subsequent waits include the whole exchange.

If the task needs approval, wait for the request and inspect its full content:

```sh
request_result=$(amira agent wait "$id" --until request --since "$cursor" \
  --timeout 60 --json)
code=$?
# 0: a request is pending. 2: none arrived before the timeout; inspect progress.
# 1 or 3: handle the error before continuing.
printf '%s\n' "$request_result" | jq .
```

For code 0, choose the request ID from `pendingRequests`. **Review the action and its
answer choices before approving.** For a boolean confirmation you have approved:

```sh
request_id=$(printf '%s' "$request_result" | jq -r '.pendingRequests[0].requestId')
amira agent respond "$id" "$request_id" true --json
# To decline that confirmation, use false; to cancel any request, use null.
```

Do not send `true` to an input, selection, or form request. If there are several
requests, inspect and answer each separately. Requests are conditional: the prompt
above does not guarantee that an approval will be needed. If none arrives, skip the
respond step. If a later wait reports more pending requests, answer them before waiting
again; a wait timeout does not dismiss them.

Collect the result, read session history, and stop:

```sh
finished=$(amira agent wait "$id" --until turn-end --since "$cursor" \
  --timeout 120 --json)
code=$?
printf '%s\n' "$finished" | jq .
# On code 2, handle pending requests or wait again; work has not been stopped.
# On code 0, inspect the root turn.end reason and assistant output.

amira agent read "$id" --since "$cursor"
amira agent read "$id" --last-turn --json
# Ensure any promoted steering/follow-up work is also finished before stopping.
amira agent wait "$id" --until idle --timeout 120 --json
amira agent stop "$id" --json
amira agent list --json
```

`stop` is also how to deliberately cancel unfinished work. To continue the retained
conversation later, use its session ID and the same working directory:

```sh
amira agent start --cwd /path/to/project --resume "$session" --json
```

This creates a new bridge ID and journal for the resumed session. Use the new ID for
later calls; do not carry an old bridge cursor into the new journal.

## Requests and settings

Requests survive client disconnections. RPC keeps waiting until an answer, cancellation,
or timeout resolves the request. The bridge adds a 30-minute request deadline from
first observation; state refreshes do not extend it. At expiry it sends explicit `null`
and records `bridge.request-timeout`. A request issuer may impose an earlier timeout.

`value-json` must be valid JSON and match the request:

| Request kind | Answer |
|---|---|
| `confirm` | `true` or `false`; `"always"` or `{"other":"..."}` only when offered |
| `input` | A JSON string, such as `'"A title"'` in a POSIX shell |
| `select`, `diff-review` | An offered string; sectioned selections may accept `{"option":"...","key":"..."}` |
| `ask` | An array of `{ "selected": ["..."], "other": "..." }`, one per question; `other` is optional |
| `form` | An object keyed by field ID |
| Any kind | `null` to cancel |

Configure positive, finite numbers of minutes; fractions are allowed, zero does not
disable either timeout:

```json
{
  "extensions": {
    "agent-bridge": {
      "idleMinutes": 30,
      "requestTimeoutMinutes": 30
    }
  }
}
```

Settings are read at start, in this override order:

1. `<Amira home>/settings.json`
2. `<target cwd>/.amira/settings.json`
3. `<target cwd>/.amira/settings.local.json`
4. `start --idle minutes` overrides only `idleMinutes`.

Idle expiry requires no running turn/work, pending request, or authenticated client
call. Background tools/subagents and recovery work also prevent idle exit. RPC events
and client calls renew activity; polling status/read keeps the bridge alive, and an
active wait pauses expiry. Unauthenticated connections do not renew activity.

Idle exit uses the same shutdown path as stop and keeps session files for resume. If
the RPC child dies unexpectedly, the bridge logs the failure, marks itself failed,
rejects outstanding calls/waits, and exits. It does not automatically restart the child.

## Cursors and recovery

Reads and waits default to cursor **0**. There is no shared "last read" position: repeated
no-cursor reads repeat the journal. Store each result's `cursor` and pass it to the next
incremental call. A read includes only events with `seq > cursor`, but pending requests
are a current-state snapshot and may be repeated.

The append-only journal lives in memory and `<Amira home>/agents/<id>.events.jsonl`.
Its monotonic `seq` is independent of RPC's sequence. Raw JSON records preserve the
original RPC event under `event`, including unknown fields, alongside bridge lifecycle
and recovery records. Cursors belong to one bridge, not to the Amira session.

Compact reads show completed assistant text, one-line tool summaries with success/error,
steering state, turn-end reasons, requests with answer commands, and errors. They end
with `cursor: n`, even when some examined events were omitted from compact output.
Partial streaming text is available in JSON events, not compact output. `--all` and
`--last-turn` use RPC `session.read`, not the journal; on resume, `--last-turn` may be
empty until this RPC process has seen a turn. Use `--all` for retained conversation.

On `events.lost`, the bridge fetches RPC state and session history and appends a
`bridge.recovered` snapshot. It reconciles session/model, work state, requests, and
completed messages. Recovery cannot recreate every lost streaming/tool/subagent event;
tool and subagent projections are marked uncertain rather than presented as complete.
While that uncertainty remains, automatic idle exit and successful `wait --until idle`
are suspended: use explicit `stop` when you have finished. This avoids cancelling unseen
background work. Tree usage is marked uncertain until a new cumulative budget event.
Status refreshes root-session usage from history rather than adding possibly overlapping
events. It separates `usage.rootSession` from `usage.currentRunTree`; do not add those
totals together. Unknown cost is `null`, not a claim of zero cost. History reads return a
conservative pre-request cursor, so subsequent incremental reads may repeat overlapping
output but do not skip events arriving after the history snapshot.

## Security and limits

- **Local transport only.** Windows uses `\\.\pipe\amira-agent-<id>`; Unix uses
  `<Amira home>/agents/<id>.sock`. There is no TCP listener, remote endpoint option, or
  HTTP server. This does not prevent Amira itself from contacting model providers or
  running network tools.
- Every client request authenticates with a random per-bridge token, read automatically
  from `<Amira home>/agents/<id>.json`. The state also stores the daemon PID, OS process
  start identity, endpoint, session ID, cwd, model, start time, and status. Tokens are
  not printed or put in command arguments. Do not publish or copy state files.
- Unix uses an owner-only `0700` agents directory and `0600` state, journal, diagnostic
  files, and socket where supported. On **Windows**, startup uses PowerShell through
  Amira's process API to protect the agents directory with an owner-only DACL before
  writing the token; files inherit that restriction. Startup fails if this cannot be
  applied. Named pipes additionally require token authentication. Protect the Amira
  home itself; this is not isolation from administrators or processes running as you.
- Anyone able to read the token can control the session with your Amira permissions.
  The bridge is not a sandbox. Treat its home, installed extensions, and local account
  as trusted. Endpoint paths and bridge IDs are validated rather than accepting an
  arbitrary network address.
- Journals and startup stderr logs can contain prompts, code, tool output, and other
  sensitive data. Transport-token redaction is not general secret redaction. Incoming
  `respond` values are not separately journaled; the journal still preserves RPC events.
  Avoid passing sensitive answers in shell arguments where process listings/history
  can expose them; there is currently no stdin option for `respond`.
- Requests are limited to 8 MiB and client responses to 128 MiB. There is no journal
  rotation, retention policy, or pagination limit option; long sessions grow memory and
  disk usage. Use incremental cursors to reduce read responses.
- State and logs survive stop/pruning, but `read` requires a running bridge; there is no
  offline journal-reader command. Resume the Amira session to read its conversation.
  Stale pruning does not delete session files or terminate an unrelated process.

## Relation to raw RPC and mcp-server

Use raw `amira --rpc` when your application can own a persistent JSONL stdin/stdout
connection and wants the full RPC surface. Agent bridge is a local lifecycle and CLI
adapter for that protocol, not a replacement protocol or a second agent implementation.
Each short-lived command closes its own connection; the daemon keeps RPC open.

The detached bootstrap uses Node's built-in spawn because the public process API has
no detached option. The RPC child uses `@amira/api` `openPipe` on Windows. On Unix it
uses a dedicated process group through Node spawn because the linked `openPipe` only
force-kills the direct PID. Shutdown targets only that owned group, never an image
name. A tool that deliberately detaches into its own group is outside this containment;
the bridge is not a sandbox.

Use [mcp-server](../mcp-server/README.md) when your host speaks MCP and wants the
`amira_run` delegation tool. That extension starts a separate `amira -p --json` process
for each call and returns the final reply. Agent bridge instead keeps one session
process alive across calls, with mid-turn steering, event cursors, and explicit UI
request responses. It does not expose an MCP server.
