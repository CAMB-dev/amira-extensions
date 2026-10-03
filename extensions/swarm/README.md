# swarm

Swarm mode for Amira: a few long-lived sub-agents (members) that work on one goal together,
through a shared blackboard and short messages to each other, while you and the main
session watch and step in.

```sh
amira ext install swarm
```

Needs Amira's extension API 0.1.1 or newer (persistent sub-agents, spawn groups, views).

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

Only the main session can start a swarm; members and other sub-agents cannot. The start
returns at once. The swarm runs in the background and, when it ends, sends the main session
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

## Watching and stepping in

- `/swarm view` opens the live view: members with their states, the blackboard, and the
  timeline of every message, write and finish. Its keys: `m` message a member
  (`name: text`, or `all: text` for every member), `p` pause or resume a member (`all`
  for the whole swarm), `x` stop a member, `s` stop the swarm.
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

The main session can use the `swarm` tool too: `status`, `message` (to a member) and
`stop`. Members' messages to `"commander"` reach it as notices. Unlike yours, the main
session's messages count against the swarm's message limit and the exchange limit with
that member, and are not progress.

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

Since 0.1.6, the adapter supplies dedicated Board and Messages tabs and each member's
recorded child session ID. With a dashboard that supports these optional fields, its session
navigation opens the member's conversation. Old records without a session ID still show
Summary and the shared tabs, but cannot offer session navigation; no ID is invented.
Older dashboards can ignore the optional fields and still read Summary and Logs.

This source is read-only. Use `/swarm` commands to message, pause, resume or stop members.
No file changes or progress percentages are inferred.

Registration tolerates dashboard being absent, loaded later or reloaded. The API has no
extension-unload callback or service-change event: a host-owned `swarm.dashboardSource`
lease immediately disables stale source reads on swarm unload, and an unref'ed one-second
check releases its registration and detects dashboard replacement. Exit releases it too.

## Settings

In `settings.json`, under `extensions.swarm`:

```jsonc
{
  "extensions": {
    "swarm": {
      "enabled": "mode",           // default: follow the session's permission mode (see below)
      "maxMembers": 6,
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
Amira's packages. Start-policy tests use public API fakes:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
