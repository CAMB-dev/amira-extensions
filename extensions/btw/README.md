# btw

Ask a side question in [Amira](https://github.com/CAMB-dev/Amira) while the main agent
keeps working. The side conversation never enters the main model's context.

```sh
amira ext install btw
```

Version **0.3.0** requires Amira extension API **0.1.46 or later within 0.1.x**, a
terminal UI with dock support, and an agent tree. Print/RPC frontends without docks
are not supported. New questions start no child when a dock is unavailable;
reload recovery can restart queued work before the dock reopens (see below).

## Commands

| Command | What it does |
|---|---|
| `/btw <question>` | Fork the main session's current context into a private side agent and open a dock. |
| `/btw <follow-up>` | While the dock is open, send another question to the same side agent. |
| `/btw clear` | Close the dock and stop the side agent, like Esc. |
| `/btw` | Reopen a restored dock, or show command help. |
| `/btw retry <id>` | Ask an interrupted question again using its short, stable ID, such as `r1`. |

`clear` and `retry <id>` are reserved when they are the entire argument. To ask
about those words, use `/btw What does clear mean here?` or a similar full question.
Retry IDs are case-insensitive: `/btw retry R1` and `/btw retry r1` do the same thing.
Keep the `r` prefix: bare numbers remain unavailable because they are ambiguous
with old numbered actions.

`/btw show` and `/btw history` were removed: the dock already shows the full live
exchange, and saved display blocks provide history after closing. `show` and
`history` are now ordinary question text, not subcommands.

## Dock and saved answers

Answers stream as Markdown into a bounded dock directly above the input. The dock
follows new output, and the main conversation and input remain usable. PgUp/PgDn
scroll the dock; the mouse wheel scrolls it when the pointer is over it; End resumes
following (subject to your host keybindings). Typing, arrows, Tab and Enter stay
with the main input.

The first **Esc** closes the dock, aborts any unfinished answer, and ends the side
agent. The next Esc performs the host's usual action, including stopping a running
main turn. `/btw clear` has the same closing behavior. Starting or steering a main
turn does not hide the dock.

Closing prints exactly one display-only block headed `btw: <first question>`, with
all questions, answers, errors and any interrupted-answer status in Markdown
`details`. The block is collapsed at summary detail; **Ctrl+O** expands it. It is
persisted with the session and restored on resume, but neither its heading nor its
details are ever sent to the main model, forks or compaction. The typed command is
not echoed into the transcript (it still appears in input recall).

Follow-ups keep the side agent's own context. A follow-up sent during an active
turn is queued by the host and may join that turn before its next model call;
several queued messages may be combined. Sending is acceptance, not a guarantee
of delivery. Failures and undelivered follow-ups appear in the dock. If the child
has ended or the dock is closed, the next question saves the previous exchange
once and starts a fresh side agent instead of trying to reuse stale state. Restored
ask-again actions remain available when their child ends; a replacement resends
any still-queued questions and keeps interrupted answers separate.
Session exit/switch also stops the child. Saved output remains bound to the session
where the side question began.

## Reload recovery

An extension reload (`/ext reload`, a settings change, or a host update) closes the
dock and cancels its child and event subscription without printing cancellation
errors. Unanswered questions are saved under the extension's `btw.pending` key in
**session-scoped `SessionData`**, with their question text, partial answer, original
ask timestamp, queue/in-flight status, and any retry identifier. There is no
separate file or direct access to the Amira home directory. With no pending
questions, no recovery snapshot is written; completed open docks still save their
usual display block. Completed
questions are also saved separately when other questions in the dock are still
pending, so their answers are not lost during recovery.

On the next load in the **same session**:

- In-flight questions appear as display-only Markdown notices marked
  **Interrupted by reload**, including any partial answer. Each notice gives an
  action such as `/btw retry r1` to ask that question again. IDs (`r1`, `r2`, …)
  come from a persisted, per-session monotonic counter and stay bound to the same
  question across reloads. Consumed, cleared, and dropped IDs are never reassigned
  within the session; their actions report unavailable. Old bare-number and UUID
  actions also report unavailable. Questions are not retried automatically, even
  if no answer text arrived before the reload.
- Queued questions are automatically sent to a fresh side agent, in order. The
  host may combine follow-ups, just as during normal operation. The new fork uses
  the main session's current context and model setting, not the cancelled child's
  private conversation.
- Questions older than **24 hours** (measured from when they were asked) and
  malformed recovery items are dropped.
- The recovery snapshot is consumed with an empty latest record. The counter's
  high-water mark is kept alongside it under `btw.retry.counter` in the same
  session-scoped `SessionData`, so clearing pending work cannot reset the counter.
  A counter record is written only when a new ID is assigned, before publishing
  its notice. `SessionData` is append-only: older recovery records remain in the
  session file but are not replayed.

API 0.1.46 opens docks only from a command context. Recovery therefore shows
interrupted answers in notices immediately; restarted queued answers also appear
as saved display blocks until you run `/btw` to reopen their dock. An ask-again
command also opens the dock. Use `/btw clear` to discard recovered work; Esc does
the same after reopening the dock. Session exit/switch keeps the existing close
behavior. Another reload preserves still-interrupted questions with their
original timestamps.

## Model, tools and privacy

The extension spawns an **ephemeral**, automatically persistent child with
`context: "fork"`. The host forks the main session's context at that moment; this
extension no longer extracts or truncates a plain-text approximation. Later main
messages are not copied into the existing side agent. Follow-ups use its private
conversation instead.

By default the host uses the **current session model**, not the global default.
To override it, set `extensions.btw.model` to a configured `provider/model`:

```json
{
  "extensions": {
    "btw": { "model": "provider/cheaper-model" }
  }
}
```

An empty, whitespace-only or non-string value leaves the session model in use.
The override is read when a new dock/child starts; it does not change an existing
side agent. Choosing another provider sends the forked context to that provider.

The child inherits the parent's local tool declarations and their order for
prompt-cache alignment, but `callableTools: ["read", "grep", "glob"]` allows only
read-only exploration. A short role instruction tells it not to change files or
the main conversation. It cannot call editing, shell, delegation, or hosted web
search tools. Hosted search must be removed by the host rather than merely blocked;
that, role instructions, a different model, interceptors and unfinished parent
calls can prevent a fully identical cache prefix.

Ephemeral children have no session/artifact files, parent sub-agent history
entries, public listings or main-bus transcript events. Folded **display blocks**
and pending-question recovery records are persisted; neither becomes model history.
Usage is booked by the host as **side usage**, with the neutral label **`btw`**, and
counts toward the session/tree budget. Neither the child title nor the group name
contains the question; the saved display block deliberately includes the Q&A,
but accounting labels do not. Command-side spawning requires a group: its generic
`btw` name, counts and usage remain public group metadata, even though the ephemeral
child and its Q&A are private. API 0.1.46 offers neither direct command-side spawn
nor a private-group option for commands.
Concurrency, depth and budget limits still apply. At a concurrency cap of
at least two the host reserves a slot for ephemeral turns; at one they queue
normally. The dock shows when a child is waiting.

## Development

From this folder, with dependencies installed in the local Amira checkout:

```sh
bun run link-amira D:/dev/Amira
bun install --ignore-scripts
bun run typecheck
bun run lint
bun test
```

Tests use strict API-only fakes and controlled child event streams: no network,
live model requests, real Amira home directory, or GUI windows. They cover spawn
options and model inheritance, Markdown streaming, same-child follow-ups, dock
close/clear, one persisted display block, errors, session isolation, unload during
streaming and with a queue, automatic reload recovery, ask-again actions, empty and
stale snapshots, and cancellation without dangling event consumers or error
output. They also check the absence of main-history reads or writes. Keyboard
priority and resume rendering are host contracts; the extension tests exercise
lifecycle hooks and print options
without launching the terminal UI.
