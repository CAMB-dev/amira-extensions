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

Each finished `agent()` call is journaled under the session directory
(`<sessions>/workflows/<run id>/journal.jsonl`, keyed by a hash of its prompt and options),
with the script and the run's state. Resuming a run replays the calls up to the first one
that changed or never finished, and runs the rest again; calls made after the script saw a
changed result run again too, since they may depend on it.

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

The tests run workflows on a real agent tree with a scripted model, so they need Amira's
packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
