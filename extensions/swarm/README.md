# swarm

Swarm mode for Amira: a few long-lived sub-agents (members) that work on one goal together,
through a shared blackboard and short messages to each other, while you and the main
session watch and step in.

```sh
amira ext install swarm
```

Needs Amira ^0.1.52. The bound runner uses owner-associated UI requests (`sessionId`),
available in the verified 0.1.52 API, as well as persistent sub-agents and spawn groups.

## Starting one

You can ask for a swarm, and the model may propose one when it clearly helps:

- `/swarm <goal>`: the main session picks the members (name, role, brief) and starts it;
- say "swarm" in a message ("use a swarm to ..."): the model calls the `swarm` tool;
- or the model proposes one on its own.

By default, `enabled: "mode"` follows the session's current permission mode at each start:

- `auto`: starts without asking and adds a notice explaining why to the transcript;
- `edits`: asks you to confirm;
- `plan`: asks you to confirm.

Missing session or permission information also falls back to asking. The same rule applies
whether you requested the swarm or the model proposed it. A confirmation shows the initiator,
the goal, the roster (names, roles, briefs), the limits and the budget. If you decline, the
model is told so and may not propose a swarm for the same goal again in this session unless
you ask for one.

Print mode (`amira -p`) uses `auto` by default, so swarms can start without a dialog. When
confirmation is required, nobody answering (print mode, or an rpc client that does not answer
dialogs) means no swarm starts. Run it in the interactive UI, or set `enabled` to `"always"`
to skip confirmation in every permission mode.

Only the main session can start a swarm through the `swarm` tool; members and other
sub-agents cannot. Other extensions can use the owner-bound service below. The start
returns after any required confirmation. The swarm runs in the background and, when it ends, sends the main session
a report with every member's result and the blackboard.

## What members get

Each member is a persistent sub-agent in the swarm's spawn group. On top of the usual tools
it gets:

| Tool | What it does |
|---|---|
| `send_message(to, text)` | Message another member, or `"commander"` (the main session) |
| `list_agents()` | Members, their roles and states, and messages left |
| `blackboard_read(key?)` | One key, or the whole board |
| `blackboard_write(key, value, append?)` | Set (or append to) a key; every write is logged |
| `finish(result)` | Declare its part done, with a short summary |

After each turn a member goes idle. A message wakes it, or, if it is working, reaches it
before its next model call; messages from one sender arrive in the order they were sent.

### Member workflows

Since 0.1.10, members can start workflows when the workflow extension provides the optional
`workflow.runner` service and `memberWorkflows.enabled` is true (the default). Without that
service, or when disabled in settings, these tools are absent for main-session starts;
the rest of the swarm works as before. Bound service runs require the updated workflow
contract below; an absent or incompatible service exposes a disabled `start_workflow`
tool explaining why, rather than falling back to legacy execution.
The main-session `workflow` tool stays excluded. Members get their own tools instead:

| Tool | What it does |
|---|---|
| `start_workflow(script?, name?, args?)` | Start an inline script or a saved workflow; load the workflow skill first |
| `workflow_status(runId?)` | Show one of the member's runs, or all its runs and pending starts |
| `stop_workflow(runId)` | Stop one of the member's runs |

Workflow confirmation still follows the workflow extension's own policy. The member's
session and name identify who started each run; workflow agents use that member's agent
tree and ancestor budgets. Status and stop cannot access another member's runs.

By default, at most **3 workflows per swarm** and **1 per member** may run at once. Pending
starts (including confirmation dialogs) reserve a slot too, so concurrent calls cannot
exceed these limits. A refused start lists the members holding the slots and their run IDs
(or pending starts), and asks the caller to coordinate using `send_message` or the board.

The swarm maintains the `workflows` blackboard key: pending starts and running workflows
appear with their owners, and disappear when they end. Changes are recorded in the timeline;
members cannot overwrite this key while the integration is enabled. Completion and failure
results arrive as messages to the member that started the workflow, waking it when idle or
waiting until it is resumed when paused. Members should end their turn rather than poll.
A pending or running workflow prevents normal idle shutdown. Stopping the swarm cancels all
member workflows, including outstanding confirmations and starts racing with shutdown.

## Watching and stepping in

- `/swarm view` opens a split view: select a member with Up/Down on the left; the right
  shows its role, state, elapsed time, own cost, current tool or last action, result,
  its own board entries and recent events/messages (newest last). At narrow widths the
  panes stack. Long text stays folded to one line. Since **0.2.1**, both swarm and workflow
  use the same navigation: `[` focuses the list pane; `]` focuses the details pane. Enter
  in the list focuses the selected member's details; Enter in details expands or folds
  the selected entry. Only the active pane has a selection bar; switching panes keeps
  the selected member and each member's expanded details. Host focus keys (Tab, `/`, or `i`)
  switch to the input; the selection dims there. `?` opens the full summary (identity, goal,
  state, elapsed time, known cost and counts), and Esc returns from it or closes the root view.
  The compact header keeps state counts visible before identity, elapsed time or cost;
  counts wrap if even they cannot fit on one row.
  Since **0.2.2**, handwritten view chrome follows the host glyph profile: ASCII mode uses
  `up/down select`, `|` separators, `...` truncation and `>`/`v` disclosure markers.
  Goals, member text, messages, board entries and results keep their original Unicode content.
  Live keys: `m` message a member (`name: text`, or `all: text`), `p` pause or resume a
  member (`all` for the whole swarm), `x` stop a member, `s` stop the swarm after confirmation.
  Swarms read back from the session are read-only and show no action keys or hints.
- `@name text` while a swarm runs sends `text` to that member instead of to the model.
  `/swarm msg <name> <text>` does the same.
- `@all text` (or `/swarm msg all <text>`) sends `text` to every member that is still
  running or idle; a paused member gets it when it is resumed. The timeline shows it once,
  as `you → all`, and the line printed (`✉ you → all (3 members)`) says how many members
  it went to.
- `/swarm pause [name]`, `/swarm resume [name]`: hold a member's messages (or everyone's)
  and deliver them later.
- `/swarm stop [name]`: stop one member, or the whole swarm.
- `/swarm list`: swarms of this session, including ones from before a resume.

With at least 80 inner columns (82 including the inset), the view reads like this
(badge glyphs follow the host theme; here the members pane is active):

```text
  Swarm sw_example · ⠋ working · 42s · $0.08                          working 1 · idle 1

  > ⠋ working researcher     │ researcher · research · ⠋ working · 42s · $0.05
    ○ idle    reviewer       │ Tool: read
                             │
                             │   ▸ Brief: Compare the two options...
                             │   ▸ Board findings: Option A...
                             │   ▸ 10:24:01 Started read
                             │   ▸ 10:24:05 you → researcher: Check B...

  ↑↓ select · [ ] panes · enter details · ? summary · m message/all · p pause/resume · x stop member · s stop · tab input · esc close
```

At 60 columns, panes stack, identity yields to counts/metrics, and complete hint groups wrap:

```text
  ⠋ working · 42s · $0.08                working 1 · idle 1

  > ⠋ working researcher
    ○ idle    reviewer

  researcher · research · ⠋ working · 42s · $0.05
  Tool: read

      ▸ Brief: Compare the two options...

  ↑↓ select · [ ] panes · enter details · ? summary
  m message/all · p pause/resume · x stop member · s stop
  tab input · esc close
```

Maintainer conventions shared with the workflow view: use a two-cell outer left spacer
(the semantic host has no margin flag), then calculate layouts from the inner `ctx.width`.
Wide panes use `divider: true`, `gap: 1` and a 22–28-cell member column. Keep counts on the
header's protected right side; truncate identity before metrics or counts, with `?` for
full summary access. Own the hints in one area with `hostKeys: "none"`: this intentionally
removes the generic host footer, not prompts or confirmation questions. Use the shared hint
words `↑↓ select · [ ] panes · enter details · ? summary`, followed by applicable actions,
`tab input` and `esc close`; in details, show `enter expand` or `enter fold` instead. Wrap
whole groups at narrow widths rather than dropping navigation or shortening labels. Host
focus toggles remain host-owned. Render the inactive pane as nonfocusable static
text: native trees highlight selected rows even when unfocused. `UiControl.focus(id)` stores
focus for the next frame, so choose the active native widget from `ctx.state.focused`
(default members); keep selection and expansion host-owned. Put the shared badge symbol
in the tree's two-cell `node` slot with `gap: 0`; selected symbol, state word and name all
use the same text/dim semantic style, while unselected badges retain their theme roles.
Use `ctx.glyphs.separator` and `ctx.glyphs.more` for separators and truncation, measuring
these strings rather than assuming single-cell symbols. API 0.1.49 exposes only a subset
of host glyphs; infer ASCII arrows and static disclosure markers from a printable-ASCII
`ctx.glyphs.rule`. If metadata is absent, keep the default Unicode chrome. Apply this
policy only when constructing decorations, never by replacing symbols in content.

Member costs are own reported usage; missing costs stay unknown, and known zero costs
show `$0.00`. Only active working members request elapsed-time refreshes; idle, paused
and ended views do not keep a timer running. Enter reveals full saved text, including
newlines, without truncating the underlying records.

Since 0.1.9, the main session has the same controls through the `swarm` tool:

- `status`: show members, blackboard keys and the latest timeline.
- `message`: send `text` to member `to`, or `to: "all"` to broadcast.
- `pause` / `resume`: hold or deliver messages for member `to`, or the whole swarm with
  `to: "all"` or no `to`.
- `stop_member`: stop one member; `to` is required and cannot be `"all"`.
- `stop`: end the whole swarm.

These controls need no confirmation; the start policy above is unchanged. The main session
may pause or stop swarms it started when they are no longer useful, stuck, or you ask, and
should tell you what it did. Members' messages to `"commander"` reach it as notices. Unlike
yours, the main session's messages count against the swarm's message limit and each
recipient's exchange limit, and are not progress. Broadcasts count once per recipient and
are refused without sending if any limit would be exceeded; the timeline records one
`commander → all` message.

`/clear` or `/resume` while a swarm runs stops it; its report then goes nowhere (the
conversation that started it is closed).

## When it ends

- every member is idle (or ended) and nothing is on its way to any member: no message,
  including messages held for a paused member, and no result of a member's own background
  work (e.g. a sub-agent it started in the background);
- you or the main session stop it;
- a limit is hit: the swarm's message limit, the members' turn limits (each member ends
  after its last turn), or the budget;
- it made no progress: after `noProgressRounds` rounds with messages but no blackboard
  change and no finished part, it pauses and asks you whether to go on (with nobody to ask,
  as in print mode, it stops). It waits for your answer.

Messages two members (or a member and the main session) exchange back and forth while
neither writes to the blackboard are capped too (`maxPairExchanges`); past that,
`send_message` tells them to write their results down instead. A member that is being
stopped takes no more messages; sending it one is refused, not dropped.

A swarm has no budget of its own unless the settings give one (since 0.1.7; before, it stopped
at 3,000,000 tokens). Without one, the session's budget (`budget` in settings), if set, still
applies to the whole agent tree, and the message, turn, no-progress and pair-exchange limits
above still stop a swarm that runs away. A `budget` covers the members and their own
sub-agents; the main session's turns answering them are its own.

The blackboard, the messages and the results are kept in the session file, so `/swarm view`
and `/swarm list` still show a swarm after `amira --resume`. Since 0.1.5, start records also
map member names to child session IDs, and end records include each member's own usage,
tokens, known cost, duration, final reply and error. Ended snapshots reconstruct those
values after resume. Old records still work; unrecorded metrics and session IDs stay unknown.
The swarm's total token count includes descendants; per-member totals do not.

## Service for other extensions

Since **0.3.0**, `api.useService("swarm.runner")` provides execution without the dashboard
or a fabricated `ToolContext`. Treat the value as `unknown`: check its methods and **all
five** capability flags plus the required `available()` query at recommendation time, at
launch and while polling a run. Installed packages, `swarm.dashboardSource`, or a legacy
runner without this contract do not establish compatibility.
These are provider/consumer-local structural contracts, not new `@amira/api` exports:

```ts
interface RunnerOwner {
  sessionId: string
  label: string
  signal: AbortSignal
  createGroup(options: SpawnGroupOptions): SpawnGroup
}
interface RunnerCapabilities {
  cwd: true
  freshRun: true
  models: true
  ownedLifetime: true
  progress: true
}
interface MemberSpec {
  name: string
  role: string
  brief: string
  model?: string // provider/model
}
interface SwarmRunner {
  capabilities: RunnerCapabilities
  available(): true | { reason: string }
  startBound(request: {
    goal: string
    members: MemberSpec[]
    cwd: string // absolute directory; explicitly supplied to every member
    startedBy: { sessionId: string; label: string }
    limits?: Record<string, unknown> // same lower-limit overrides as the tool
  }, owner: RunnerOwner): Promise<{ runId: string } | { error: string }>
  status(runId: string): SwarmRunSnapshot | undefined
  stop(runId: string): boolean
  onProgress(runId: string, listener: (snapshot: SwarmRunSnapshot) => void): () => void
  onResult(runId: string, listener: (report: SwarmRunReport) => void): () => void
}
```

Added in **0.3.1**, `available()` is a synchronous, live policy query: it opens no dialogs, calls no models
and makes no network requests. It returns `{ reason }` when current settings contain
`extensions.swarm.enabled: never` or this provider has unloaded; otherwise it returns
`true`, including while a run is active. It does not reserve a slot or authorize a start.
Settings changes are visible on the next query, not cached at registration. If availability
is lost during a run, consumers must stop and drain that run through the **original**
runner reference, even if service discovery now returns a replacement or nothing. Status,
stop and result subscriptions remain usable on the original runner for this cleanup.

`SpawnGroupOptions` and `SpawnGroup` are public API types. Bind `createGroup` to the
caller's owned handle (for example, `options => owned.createGroup(options)`), not
`api.session()` or another mutable root. `startedBy` is attribution; the owner determines
group creation, lifetime and the UI session for confirmations and no-progress questions.
Start still follows swarm settings: `never` returns an error, `always` skips confirmation,
and bound starts under `mode` ask because the structural owner does not expose permission
mode. A project approval does not bypass this provider confirmation.

Each start creates a new board, group and fresh member context, uses explicit cwd with
no role worktree isolation, and preserves member model selections. Members remain persistent
within this run only. Snapshots include state, members' child session IDs, effective
models, activity and errors. `SwarmRunSnapshot` extends the usual swarm snapshot with
`runId`, effective `cwd` and `startedBy`; `SwarmRunReport` adds those fields to the final
report (member outcomes, session IDs, effective models, errors, board, usage and reason).
Status and progress payloads are detached copies. Progress replays the current snapshot
in a microtask; final results replay in a microtask **only after** `done` settles, including
member results, member workflow shutdown and group settlement. Unsubscribing suppresses
queued replay. Unknown run IDs have no status or callbacks; stop returns false for a
non-live run. Listener errors are reported without failing the run. Settlement covers public
group/child lifecycles, not the host's stronger resource-disposal barrier: stop/drain the
owning conversation before acceptance checks or reusing/removing its iteration worktree.

There is **one live or stopping swarm per extension**, shared by tool and service starts.
A pending confirmation also reserves that slot, so concurrent starts cannot bypass it.
Stopping does not release the slot until shutdown settles. Owner abort and provider unload
cancel pending confirmations and stop members; late confirmation cannot launch work.
Switching the main session does not orphan bound runs or redirect their UI. The old
main-session tool's `/clear` and `/resume` behavior is unchanged. Service results remain
available in memory for this provider instance; consumers must persist their own evidence.

Member workflows of a bound swarm use `workflow.runner.startBound` with the **same cwd and
owner**, member attribution, and a signal combining owner, tool and swarm cancellation.
The workflow service must structurally provide `available(): true | { reason: string }`,
`start`, `startBound`, `status`, `stop`, `onProgress`, `onResult` and all five true capability
flags. Availability is checked before and after each bound start; a disabled provider's
reason is included in the error, and a run returned after availability is lost is stopped
and drained through the original runner. Its `startBound` request adds `cwd` to
`{ script?, name?, args?, startedBy }`, takes the same `RunnerOwner`, and returns
`{ runId } | { error }`. A missing method/flag, service replacement or unload disables new
member workflow starts with a clear reason; **legacy `start` is never a fallback** for a
bound run. Explicit `memberWorkflows.enabled: false` removes the tools. Legacy main-session
swarms keep their existing workflow integration, including older services with only `start`, `status`, `stop` and `onResult`; the settings-aware availability query is mandatory for **bound** execution, not a new requirement for that legacy unbound path.

Consumers must handle start errors and recheck service identity/capabilities, never silently
switch an approved mode or cwd. If the provider is absent, disabled, old or unloaded, block
that mode and obtain fresh human approval before choosing a different execution mode.
Cwd is an execution binding, not a filesystem write sandbox.

## Optional dashboard

With the dashboard extension installed, `/dashboard swarm` shows one phase per swarm in
the current session and one agent per member, including its role and live state (queued,
running, idle, paused, done, failed or stopped). Swarm operation does not require dashboard.
The dashboard itself requires its newer Amira API; this adapter uses the optional
`dashboard.sources` service and public API types only.

- **Summary** shows the brief, last model reply, result, token usage, known cost, duration,
  child session ID and error. Unknown costs are not displayed as zero; known zero cost is.
- **Board** shows the shared blackboard; **Messages** shows the last 200 timeline entries,
  including messages, writes and finishes. Both tabs show an empty state before anything is
  recorded. Long text is clipped for display; saved records remain intact. **Logs** points
  to these tabs rather than repeating their contents.
- Changes appear while the swarm runs. Ended swarms reconstruct from the session records
  after resume or extension reload; an interrupted swarm or old member without a recorded
  outcome is shown as stopped, not assumed successful.
- A member the swarm winds down normally, once every member is idle with no message on its
  way, shows done (since 0.3.2). Stopped means the user, a limit or an error ended it.

Since 0.1.6, the adapter supplies dedicated Board and Messages tabs and each member's
recorded child session ID. With a dashboard that supports these optional fields, its session
navigation opens the member's conversation. Old records without a session ID still show
Summary and the shared tabs, but cannot offer session navigation; no ID is invented.
Older dashboards can ignore the optional fields and still read Summary and Logs.

This source is read-only. Use `/swarm` commands to message, pause, resume or stop members.
No file changes or progress percentages are inferred.

Registration tolerates dashboard being absent, loaded later or reloaded. Services have no
change event: a host-owned `swarm.dashboardSource` lease immediately disables stale source
reads on swarm unload, and an unref'ed one-second
check releases its registration and detects dashboard replacement. Exit releases it too.

## Settings

In `settings.json`, under `extensions.swarm`:

```jsonc
{
  "extensions": {
    "swarm": {
      "enabled": "mode",           // default: follow the session's permission mode (see below)
      "maxMembers": 6,
      "memberWorkflows": {
        "enabled": true,          // needs the workflow.runner service
        "maxRunning": 3,          // across this swarm, including pending starts
        "maxPerMember": 1
      },
      "limits": {
        "maxMessagesPerMember": 30,
        "maxMessages": 150,
        "maxTurnsPerMember": 20,
        "noProgressRounds": 3,
        "maxPairExchanges": 8,
        "maxConcurrent": 3,        // members working at once (the agent tree's limit applies too)
        "budget": { "tokens": 3000000, "costUsd": 2 } // for the whole swarm, within the tree's
      }
    }
  }
}
```

`enabled` controls confirmation:

- `"mode"` (default): starts without asking in `auto`; asks in `edits` and `plan`, or when
  permission information is unavailable. Switching permission modes affects the next start.
- `"ask"`: confirms every start, including in `auto`.
- `"always"`: starts without asking in any permission mode.
- `"never"`: disables swarms.

A start may lower the message and turn limits (`limits` of the `swarm` tool), never raise
them.

Older settings still work: `"enabled": "explicit"` reads as `"ask"`. Without `enabled`,
`"confirm": false` reads as `"always"` and `"confirm": true` as `"ask"`. As before,
`"confirm": false` also turns `"ask"` or `"explicit"` into `"always"`; it does not override
`"mode"` or `"never"`. Since 0.1.1, `"always"` starts swarms without the confirmation
(before, `"always"` with the default `"confirm": true` still asked).

## Tests

The integration tests run swarms on a real agent tree with a scripted model, so they need
Amira's packages. Rendering regressions use the real host `ExtensionViewer` at 120×36,
80×24 and 50×20 for live and read-only views. ASCII fixtures are checked for any non-ASCII
output after removing ANSI styling; a separate test verifies Unicode content is preserved.
Custom separator/more glyphs, full summaries, expansion and inactive panes are covered too.
Start-policy tests use public API fakes:

```sh
bun install
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun run typecheck
bun run lint
bun test
```

Run bun install in this extension to install its declared development dependencies, including
@types/bun, TypeScript and Biome. The linker touches only @amira/* package junctions; it
never installs, creates or replaces @types, bun-types, compiler or lint packages.
No extra PATH or typeRoots flags are needed for the documented check commands.
