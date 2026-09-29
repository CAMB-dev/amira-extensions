# swarm

Swarm mode for Amira: a few long-lived sub-agents (members) that work on one goal together,
through a shared blackboard and short messages to each other, while you and the main
session watch and step in.

```sh
amira ext install swarm
```

Needs Amira's extension API 0.1.1 or newer (persistent sub-agents, spawn groups, views).

## Starting one

A swarm only starts when you ask for one:

- `/swarm <goal>`: the main session picks the members (name, role, brief) and starts it at
  once;
- or say "swarm" in a message ("use a swarm to ..."): the model may then call the `swarm`
  tool, and you confirm the roster before it starts.

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
  (`name: text`), `p` pause or resume a member (`all` for the whole swarm), `x` stop a
  member, `s` stop the swarm.
- `@name text` while a swarm runs sends `text` to that member instead of to the model.
  `/swarm msg <name> <text>` does the same.
- `/swarm pause [name]`, `/swarm resume [name]`: hold a member's messages (or everyone's)
  and deliver them later.
- `/swarm stop [name]`: stop one member, or the whole swarm.
- `/swarm list`: swarms of this session, including ones from before a resume.

The main session can use the `swarm` tool too: `status`, `message` (to a member) and
`stop`. Members' messages to `"commander"` reach it as notices.

## When it ends

- every member is idle (or ended) and no message is on its way, including messages held
  for a paused member;
- you or the main session stop it;
- a limit is hit: the swarm's message limit, the members' turn limits (each member ends
  after its last turn), or the budget;
- it made no progress: after `noProgressRounds` rounds with messages but no blackboard
  change and no finished part, it pauses and asks you whether to go on (with nobody to ask,
  as in print mode, it stops).

Messages two members exchange back and forth while neither writes to the blackboard are
capped too (`maxPairExchanges`); past that, `send_message` tells them to write their
results down instead.

The blackboard, the messages and the results are kept in the session file, so `/swarm view`
and `/swarm list` still show a swarm after `amira --resume`.

## Settings

In `settings.json`, under `extensions.swarm`:

```jsonc
{
  "extensions": {
    "swarm": {
      "enabled": "explicit",       // "explicit" (only when you ask), "always", or "never"
      "confirm": true,             // confirm starts the model makes (/swarm never asks)
      "maxMembers": 6,
      "limits": {
        "maxMessagesPerMember": 30,
        "maxMessages": 150,
        "maxTurnsPerMember": 20,
        "noProgressRounds": 3,
        "maxPairExchanges": 8,
        "maxConcurrent": 3,        // members working at once (the agent tree's limit applies too)
        "budget": { "tokens": 2000000, "costUsd": 2 } // for the whole swarm, within the tree's
      }
    }
  }
}
```

A start may lower the message and turn limits (`limits` of the `swarm` tool), never raise
them.

## Tests

The tests run swarms on a real agent tree with a scripted model, so they need Amira's
packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
