# todo

A todo list for [Amira](https://github.com/CAMB-dev/Amira): the model writes its plan for
multi-step work as a list, keeps it current as it goes, and you watch it live above the
activity line.

```sh
amira ext install todo
```

Needs Amira extension API 0.1.2 or later (live panels).

## What you see

```
Todos 1/3 · › Running the tests
  ✓ Write the parser
  › Running the tests
  • Update the docs
```

- The panel sits above the activity line, in full-screen and inline mode. Done items are
  muted, the item in progress is in the accent color (in its "-ing" form), pending ones are
  plain. A long list shows a window around the item in progress.
- `Ctrl+T` (the `panels.toggle` key) folds the panel to its first line, and unfolds it.
- Once everything is done, the panel stays until the turn ends, then steps aside.
- The transcript gets the list only when it changes meaningfully: the first plan, items
  added, removed or reworded, everything done, the list cleared. Calls that only move items
  along show one line (`› Running the tests`).
- `/todos` prints the list.

## Tools

| Tool | |
|---|---|
| `todo_write` | Replaces the whole list: `todos: [{ id, content, status, activeForm? }]`, status `pending`, `in_progress` or `done` (`completed` is taken too). An empty list clears it. |
| `todo_read` | The list with ids and statuses. |

The tool description tells the model to use the list for work of three or more steps, to keep
exactly one item in progress and to mark items done as soon as they are. A list with more
than one item in progress, or none while items are pending, is accepted with a reminder.

## Sessions

Every list is recorded in the session (its custom entries, under `todo`), so `amira -c` and
`/resume` bring the list back, before the model does anything. Each session, sub-agents'
included, has its own list; the panel shows the one of the session on screen.

## Tests

The tests run the extension on a real agent with a scripted model, so they need Amira's
packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
