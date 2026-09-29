---
name: workflow
description: How to write workflow scripts for the workflow tool (fan-out and verify, pipelines, loop until nothing new), with the script API. Load it before writing a workflow, and only when the user asked for one.
---

# Writing workflow scripts

A workflow is a TypeScript script that orchestrates many sub-agents deterministically. The
`workflow` tool runs it in the background and sends you its return value as a message when it
ends. Use one only when the user asked for a workflow (or ran `/workflow`); otherwise propose
it in a sentence (what it would do, roughly how many agents) and let the user decide. The user
confirms every start and sees the script's name, description, phases and estimated size.

## Shape

```ts
export const meta = {
  name: "review-packages",               // letters, digits, - _ .
  description: "Review each package, then check the findings",
  phases: ["Review", "Verify"],
}

phase("Review")
const reviews = await parallel(
  args.packages.map((p: string) => () =>
    agent(`Review packages/${p} for correctness bugs. List each finding with file:line.`, {
      label: p,
      role: "reviewer",
    }),
  ),
)

phase("Verify")
const confirmed = await agent(`Check these findings against the code; keep only real ones:\n${reviews.join("\n\n")}`, {
  label: "verify findings",
  role: "reviewer",
  schema: {
    type: "object",
    properties: { findings: { type: "array", items: { type: "string" } } },
    required: ["findings"],
  },
})
return confirmed
```

- `meta` comes first and must be a plain literal (no variables, calls or `${}`).
- The top level is an async function body: use `await`, and end with `return value`. The
  value must be plain data (JSON); it is what you receive when the run ends.
- Call the tool with `script` (the source) and `args` (any JSON), or `name` for a saved
  workflow. Saved workflows live in `.amira/workflows/<name>.ts` (project) and
  `~/.amira/workflows/<name>.ts` (user); the user runs them with `/workflow <name> [args]`.

## API

| | |
|---|---|
| `agent(prompt, opts?)` | Starts a sub-agent; resolves to its final text, or with `opts.schema` to the value it returned. Rejects if it fails. |
| `opts` | `label` (progress tree), `phase`, `schema` (JSON Schema), `role` (`explorer`, `coder`, `reviewer` or the user's), `model` (`"provider/model"`), `isolation` (`"worktree"` for coders that may touch the same files) |
| `parallel(thunks)` | Runs `() => ...` functions at once; results in order, `null` for one that threw. |
| `pipeline(items, ...stages)` | Each item goes through the stages `(previous, item, index) => ...`; items do not wait for each other. `null` for an item that failed. |
| `phase(title)` | Agents started after it are listed under that phase. |
| `log(...parts)` | A line in the run's log (`/workflow view`). |
| `workflow(name, args)` | Runs a saved workflow inside this one (one level only), sharing its limits and journal. |
| `args` | The run's arguments. |
| `budget` | `total`, `spent()`, `remaining()` in tokens (`total` is Infinity without a budget). |

There is nothing else: no imports, files, processes, network or timers. `Date.now()`,
`new Date()` and `Math.random()` throw, because a resumed run must take the same path; pass
dates or seeds in `args`.

## Writing good prompts

Each agent sees only its prompt: nothing of the conversation, the script, or other agents.
Put everything it needs in the prompt: the goal, the files or area, what to return and in what
form. Ask for a `schema` when the script needs to use the answer (counts, lists, verdicts);
use plain text when the answer only goes back to you. Use read-only roles (`explorer`,
`reviewer`) for anything that should not change files.

## Patterns

**Fan-out and verify.** Split the work, run the parts in parallel, then have an independent
agent check the combined result. A verifier should get the claims and be told to check them
against the source, not to trust them.

**Pipeline.** When every item goes through the same steps (draft, then review, then fix), use
`pipeline(items, draft, review, fix)`: fast items move on without waiting for slow ones.

**Loop until dry.** Repeat a search until a round finds nothing new, with a bound:

```ts
const seen = new Set<string>()
for (let round = 1; round <= 5; round++) {
  phase(`Round ${round}`)
  const found = await agent(`Find bugs in src/ not in this list:\n${[...seen].join("\n") || "(none yet)"}`, {
    label: `hunt ${round}`,
    schema: { type: "object", properties: { bugs: { type: "array", items: { type: "string" } } }, required: ["bugs"] },
  })
  const fresh = found.bugs.filter((b: string) => !seen.has(b))
  if (!fresh.length) break
  for (const b of fresh) seen.add(b)
  if (budget.remaining() < 50_000) break
}
return [...seen]
```

## Limits, progress and resume

- A run has limits from settings `workflow`: at most 30 agents in all and 6 at once by
  default, and an optional token budget. An `agent()` past the limit rejects; keep fan-outs
  proportional (tens of agents, not hundreds).
- The user watches with `/workflow view`, and can stop a run with `/workflow stop`.
- Every finished `agent()` result is journaled. To resume a failed or stopped run, call the
  tool with `resume: "<run id>"` (and `script` to use an edited script): calls up to the first
  change replay from the journal, the rest run again. Keep prompts stable (no counters or
  times in them) so they replay.
- Do not wait or poll after starting a run: end your turn; the result comes to you.
