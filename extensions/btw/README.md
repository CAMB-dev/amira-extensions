# btw

Ask a side question in [Amira](https://github.com/CAMB-dev/Amira) while the main agent
keeps working. The side conversation never enters the main model's context.

```sh
amira ext install btw
```

Version **0.2.0** requires Amira extension API **0.1.44 or later within 0.1.x**, a
terminal UI with dock support, and an agent tree. Print/RPC frontends without docks
are not supported; no child is started when a dock is unavailable.

## Commands

| Command | What it does |
|---|---|
| `/btw <question>` | Fork the main session's current context into a private side agent and open a dock. |
| `/btw <follow-up>` | While the dock is open, send another question to the same side agent. |
| `/btw clear` | Close the dock and stop the side agent, like Esc. |
| `/btw` | Show command help. |

`clear` is reserved when it is the entire argument. To ask about that word, use
`/btw What does clear mean here?`.

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
once and starts a fresh side agent instead of trying to reuse stale state.
Session exit/switch also stops the child. Saved output remains bound to the session
where the side question began.

Each extension instance registers a fresh dock identity. After `/reload`, the next
`/btw <question>` replaces the old dock, saving its pending Q&A once and stopping
its child. Esc and `/btw clear` then operate on the new dock normally. API 0.1.44
still has no unload callback, so reload/unload alone cannot trigger immediate
cleanup; close the dock first when you need that guarantee.

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
entries, public listings or main-bus transcript events. Only the folded
**display block** is persisted; the side conversation never becomes model history.
Usage is booked by the host as **side usage**, with the neutral label **`btw`**, and
counts toward the session/tree budget. Neither the child title nor the group name
contains the question; the saved display block deliberately includes the Q&A,
but accounting labels do not. Command-side spawning requires a group: its generic
`btw` name, counts and usage remain public group metadata, even though the ephemeral
child and its Q&A are private. API 0.1.44 offers neither direct command-side spawn nor a private-group
option for commands.
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
close/clear, one persisted display block, errors, session isolation, and the
absence of main-history reads or writes. Keyboard priority and resume rendering
are host contracts; the extension tests exercise lifecycle hooks and print options
without launching the terminal UI.
