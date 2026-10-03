# btw

Ask a quick side question in [Amira](https://github.com/CAMB-dev/Amira) while the main
agent keeps working. The question and answer stay out of the main conversation.

```sh
amira ext install btw
```

Requires Amira extension API **0.1.24 or later within 0.1.x**.

## Commands

| Command | What it does |
|---|---|
| `/btw <question>` | Ask using the conversation so far. A new question cancels and replaces an unfinished one. |
| `/btw clear` | Hide the panel and cancel an unfinished question. Keep completed answers in memory. |
| `/btw show` | Open the current question and full answer in a scrollable view. |
| `/btw history` | Open the last five completed Q&As, oldest first. |

In the terminal UI, a live panel above the input/activity line shows `btw: <question>`,
then `thinking…`, then the first eight lines of the answer. Long lines are clipped by
Amira; `/btw show` displays the full text with wrapping and scrolling. Esc or q closes
the view. The standard panel-folding key (Ctrl+T by default) folds it to its heading;
there is no per-panel dismiss key, so use `/btw clear`.

The next side question replaces the panel. Sending a main message hides it, even if the
side answer arrives later. Completed answers remain available until you leave the session,
reload the extension or exit; they are never persisted or included as context for later
side questions. Errors appear in the panel, not the main transcript.

**Core limitation:** the TUI always echoes the typed slash-command line in its visible
transcript. The command API has no option to suppress that echo. The extension adds no
answer/output there, and the echo is not a model-history message. A completely echo-free
interaction would require a core API change.

`clear`, `show` and `history` are reserved when used as the entire argument. To ask about
one of those words, use a question such as `/btw What does clear mean here?`.

## Model and context

The extension makes one `api.complete` call per question. It defaults to the current
session model. To use another model, add this to your Amira settings (replace the example
with a configured provider/model):

```json
{
  "extensions": {
    "btw": { "model": "provider/cheaper-model" }
  }
}
```

The request includes a brief system instruction, the most recent **60,000 characters**
of conversation context, and your question. Context includes user/assistant text and
short tool-call/result summaries (arguments/results limited to 240 characters each).
Images, reasoning and provider metadata are dropped. Old context is trimmed first,
including part of the oldest remaining message if necessary. The remaining context stays
in chronological order. The question and system instruction are outside that budget.
Choosing another provider sends this context to that provider.

The side model has **no tools or hosted web search** and cannot change anything.
`api.complete` does not stream, so the panel shows a waiting message until the answer
is ready. Usage is host-accounted with the label **`btw`**, appears in `/cost`, and
counts toward the session's agent-tree budget. Amira writes `side_usage` bookkeeping,
not conversation messages; this extension never writes session data or sends to the
main agent. Cancellation aborts the request, but provider charges already incurred
may not be reflected in local accounting.

## Running alongside a turn

No busy-command flag is needed. In Amira 0.1.24, TUI slash-command dispatch happens
before steering/queueing and does not await earlier commands. RPC also dispatches
`command.run` concurrently. `/btw` stays awaited by the command host so TUI command
cancellation can reach its AbortSignal; another `/btw` can still replace it immediately.

Print mode awaits the answer and prints it to command output; it has no ongoing input
loop for mid-turn commands. RPC likewise returns the answer through command output.
Use RPC `command.run`, not `prompt` (which would send text to the main agent):

```json
{"id":"side-1","cmd":"command.run","text":"/btw Why use a map here?"}
```

`show` and `history` print their contents in print/RPC mode. In RPC, another `/btw`
or `/btw clear` cancels a pending call. Core's RPC `abort` targets the main agent,
not commands; print/RPC do not currently supply a command-specific cancellation signal.
Session end and extension unload also abort pending side calls.

## Development

From this folder, with dependencies installed in the local Amira checkout:

```sh
bun install
bun scripts/link-amira.ts D:/dev/Amira
bun test test
bun run typecheck
bun run lint
```

Tests use an API-only harness with controlled completions (no network or paid model
requests). They cover context trimming, request shape, cancellation, panel/view lifecycle,
session isolation, main-conversation immutability and print/RPC output.
