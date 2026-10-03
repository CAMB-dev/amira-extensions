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
`/workflow <name>`. By default, `enabled: "mode"` follows the current permission mode at each
start: **auto** starts without asking; **edits** and **plan** ask you to confirm. Shift+Tab
changes the mode during a session. This applies whether the model proposes the workflow or
you ask for it. If the host supplies no permission info, it asks as well.

The confirmation shows whether the model proposes it or you asked for it, and the script's
name, description, phases, estimated number of agents (or "dynamic") and limits. If you
decline, the model is told so and may not propose the same workflow (by name, or the same
script renamed) again in this session unless you ask for it; a different workflow may still
be proposed. An auto-mode start says "started without asking: permission mode is auto" in
the transcript.

With the default setting and Amira's default **auto** permission mode, the model can start
workflows in `amira -p`. Where nobody can confirm (print mode, an rpc client that does not
answer dialogs), **edits**, **plan**, missing permission info, or explicit `"ask"` refuse the
start. Use the interactive UI to confirm, or set `enabled` to `"always"` to skip confirmation.

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
Since **0.1.9**, swarm members can instead use the swarm's own workflow tools through the
optional `workflow.runner` service (see below).

Since **0.1.8**, the model can also inspect and stop workflows through the tool:

| Tool action | |
|---|---|
| `start` (default) | Run `script` or saved `name` with `args`, or `resume` a run from its journal |
| `status` | Progress for `id`, or all runs started in this session: status, phase states, agent counts, tokens, cost and elapsed time |
| `list` | Saved workflows and runs started in this session |
| `stop` | Stop `id`, or all running runs in this session, including their unfinished agents |

Existing calls with only `script`/`name`/`args`/`resume` still start a run. Stopping through the
tool needs no confirmation. The model may stop runs it started when they are no longer
useful, stuck, or you ask, and should tell you when it does. Start confirmations are unchanged;
you can still intervene with `/workflow stop`.

## Workflows started by swarm members

With both extensions installed, swarm members get `start_workflow`, `workflow_status` and
`stop_workflow` when `extensions.swarm.memberWorkflows.enabled` is on (the default). They can
inspect and stop only their own runs. Swarm defaults allow **3 running workflows per swarm**
and **1 per member**, including starts awaiting confirmation. Members coordinate through the
`workflows` blackboard entry and direct messages; a limit response names the owners and runs.
The swarm stays active while a member waits for a workflow. Results and failures go back to
the starting member, not as duplicate notices to the main session. Stopping the swarm stops
its member workflows, including starts awaiting confirmation.

Every start follows the same workflow settings, permission-mode policy, validation, limits,
journal and dashboard path as the main tool. Required confirmations are shown to you, not
the member. `startedBy: { sessionId, label }` is stored in `run.json` and shown in the progress
view and dashboard; attribution survives resume. No new budget is imposed: configured
workflow budgets and the starting member's session/tree limits still apply. Workflow agents
receive neither swarm nor workflow tools, including the member tools; they cannot start a
swarm or another orchestration run. The script-level `workflow(name, args)` helper still
runs saved scripts within the same run's limits and journal.

Extensions can use the optional service without importing this package:

- `api.useService("workflow.runner")` returns the runner when workflow is installed.
- `start({ script?, name?, args?, startedBy: { sessionId, label } }, ctx)` returns
  `Promise<{ runId } | { error }>` and uses the caller's `ToolContext` to create its spawn group.
- `status(runId)` returns `{ runId, name, status, startedBy?, result?, error? }`, or `undefined`
  for an unknown run. It describes runs started in this extension instance.
- `stop(runId)` returns whether it stopped a running run; stopping needs no confirmation.
- `onResult(runId, callback)` delivers the settled status/result/error once and returns an
  unsubscribe function. Late subscribers also receive the result, in a microtask.

Consumers enforce their own ownership and concurrency rules; the service does not expose
any extra tools to sub-agents.

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

Since **0.1.6**, the adapter supplies child session IDs for dashboard navigation, including
original child IDs for cached calls. Calls that never spawned a child have no session link.
Tokens, model, and child session ID also appear in **Summary**, with results and errors in
**Logs**. The adapter advertises no actions or inferred file changes/diffs. Use
`/workflow stop` to stop a run.

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
      "enabled": "mode",       // default: follow the current permission mode (see below)
      "maxAgents": 30,         // agents a run may start in all
      "maxConcurrent": 6,      // agents of a run working at once (the tree's own limit still applies)
      "budget": { "tokens": 2000000, "costUsd": 5 }   // optional; spent, the run's agents are stopped and no more start
    }
  }
}
```

`enabled` accepts `"mode"` (default: **auto** starts without asking; **edits**, **plan**, or
missing permission info ask), `"ask"` (confirm every start), `"always"` (start without asking),
or `"never"` (refuse every start). Explicit settings override the permission mode.

## Tests

The tests run sandboxed workflow scripts with fake spawn groups and a fake dashboard service
registry, without model or network calls. Link Amira's public API packages for development:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
