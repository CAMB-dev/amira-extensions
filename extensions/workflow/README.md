# workflow

Dynamic workflows for [Amira](https://github.com/CAMB-dev/Amira): TypeScript scripts that
orchestrate many sub-agents (fan out, verify, pipelines, loops), run in the background with
limits of their own, and can be resumed from a journal.

```sh
amira ext install workflow
```

## Starting a workflow

The model may propose a workflow when one clearly helps, and you can ask for one yourself:
say so in your message ("use a workflow to ..."), or run `/workflow <task>` or
`/workflow <name>`. Every start asks you to confirm, showing whether the model proposes it or
you asked for it, and the script's name, description, phases, estimated number of agents
(or "dynamic") and limits. If you decline, the model is told so and may not propose the same
workflow (by name, or the same script renamed) again in this session unless you ask for it;
a different workflow may still be proposed.

Where nobody can confirm (print mode, an rpc client that does not answer dialogs), the model
cannot start one: run it yourself with `/workflow <name>` in the interactive UI, or set
`enabled` to `"always"`.

Since 0.1.1, `"always"` starts workflows without the confirmation (before, it only let the
model start one unasked, and every start was still confirmed). The earlier default
`"explicit"` reads as `"ask"`.

| Command | |
|---|---|
| `/workflow` | Saved workflows and this session's runs |
| `/workflow <name> [args]` | Run a saved workflow; `args` is JSON, or else plain text |
| `/workflow <task>` | Ask the model to do the task with a workflow |
| `/workflow view [id]` | The live progress tree: phases, agents, status, tokens, cost (`x` stops the run) |
| `/workflow stop [id]` | Stop a run; its unfinished agents are stopped |
| `/workflow resume <id> [args]` | Resume a run from its journal |

A running workflow shows as one line under the call that started it. When it ends, its result
goes to the model as a message, and the transcript shows a short line.

Only the main session has the `workflow` tool and command: sub-agents, at any depth, never do.

## Scripts

```ts
export const meta = { name: "triple-check", description: "Three looks, then a verdict", phases: ["Look", "Verify"] }

phase("Look")
const looks = await parallel(["api", "core", "tui"].map((p) => () => agent(`Summarize packages/${p}`, { label: p, role: "explorer" })))
phase("Verify")
return await agent(`Check these summaries against the code:\n${looks.join("\n\n")}`, { role: "reviewer" })
```

Scripts see only `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `args` and
`budget` ([`workflow.d.ts`](workflow.d.ts) has the types), plus plain language builtins
(`Object`, `Array`, `JSON`, `Math`, `Map`, `Promise`, `Intl`, ...); `console` writes to the
run's log. They run in a Worker where every other global, the global object itself
included, is out of reach: no imports, files, processes, network or timers. `Date.now()`,
`new Date()`, `Math.random()` and formatting the current time throw, so a resumed run takes
the same path. The agents a script starts have the tools their role gives them; the
sandbox only limits the script.

Save scripts as `.amira/workflows/<name>.ts` in a project or `~/.amira/workflows/<name>.ts`
for yourself. A script can run a saved one with `workflow(name, args)`, one level deep; it
shares the run's limits, budget and journal.

The package's `workflow` skill teaches the model to write scripts.

## Journal and resume

Since **0.1.5**, every settled `agent()` call is journaled under the session directory
(`<sessions>/workflows/<run id>/journal.jsonl`, keyed by a hash of its prompt and options),
including validation and spawn errors, failed children, stopped calls, and cached results.
Each new entry includes `status` (`done`, `error`, `aborted`, or `cached`), `startedAt`,
`durationMs`, call and attempt numbers, and the prompt and phase. `error`, `model`, tokens,
and cost are included when known. `sessionId` is the **child** session ID, never the parent:
cached calls retain the original child ID; pre-spawn failures have no child ID. Journal lines
retain completion order; `call` records script-call order, including parallel calls.

The script and the run's state are kept alongside the journal. Resuming replays only
successful entries (including cached successes and older journals without a status).
A failure, stop, or changed call ends the replay prefix: calls made after the script saw a
new result run again, since they may depend on it. Independent calls in the same parallel
batch can still replay. A later failed attempt never uncovers an older success for the same
call. Stopping waits for in-flight agents and worktree preparation/cleanup to settle before
the final `run.json` and result notice are written; a settling run cannot be resumed yet.

Final `run.json` includes `totals`: `tokens`, `cost` (USD), `durationMs`, `agents`, and
`byStatus` counts for `queued`, `working`, `done`, `error`, `aborted`, and `cached`.
These totals describe the **current attempt**, not the sum of previous attempts. Cached
calls and pre-spawn failures spend zero new tokens/cost. Usage covers each directly spawned
child's own usage, not its descendants; an unknown contribution makes that total `null`,
not a partial sum. Call duration includes queueing and cleanup; run duration is elapsed wall
time through settlement, not the sum of overlapping agents' durations.

## Optional dashboard

With the dashboard extension installed, `/dashboard workflow` shows live workflow runs and
finished runs loaded from `run.json` and `journal.jsonl` beside this session's files (or
`~/.amira/workflow-runs` when the session has no file). It shows declared script phases,
call status and duration, known cost, and prompt/result/error details. Finished runs show
the last attempt, in script-call order. Legacy journals without attempt numbers show the
latest recorded outcome of each call instead. Live updates notify the dashboard without
doing filesystem work during rendering.

The dashboard source contract has no token or child-session fields, custom tabs, or session
navigation. Tokens, model, and child session ID therefore appear as **Summary** text, with
results and errors in **Logs**. IDs are informational, not links; the adapter advertises no
actions or inferred file changes/diffs. Use `/workflow stop` to stop a run.

Dashboard is optional: workflow still runs when its service is absent. The adapter mirrors
its structural contract locally and imports no dashboard code. It re-registers when the
service is replaced, releases subscriptions on session end/exit, and uses a host-owned
service lease with a one-second, unref'ed check to release its registration and stop runs
after workflow unload/reload. This check is needed because the public API has no service
removal or extension unload event.

## Settings

```jsonc
// settings.json
{
  "extensions": {
    "workflow": {
      "enabled": "ask",        // "ask" (default): confirm every start; "always": start without asking; "never"
      "maxAgents": 30,         // agents a run may start in all
      "maxConcurrent": 6,      // agents of a run working at once (the tree's own limit still applies)
      "budget": { "tokens": 2000000, "costUsd": 5 }   // optional; spent, the run's agents are stopped and no more start
    }
  }
}
```

## Tests

The tests run sandboxed workflow scripts with fake spawn groups and a fake dashboard service
registry, without model or network calls. Link Amira's public API packages for development:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
