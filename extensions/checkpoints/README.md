# checkpoints

Checkpoints for Amira: before each turn, a snapshot of the files in your working tree, and
`/rewind` to go back to any of them, the files alone or the conversation too.

```sh
amira ext install checkpoints
```

Needs git (2.40 or newer to keep line endings byte for byte, see below).

## What a checkpoint is

Before the first model call of every turn, the extension snapshots the working tree: tracked
files with their changes (also ones you track although `.gitignore` ignores them), and
untracked files too, except what `.gitignore` ignores. Each snapshot is a commit under a
private ref, `refs/amira/checkpoints/<session>/<n>`, written
with an index of the extension's own. Your branch, your index (what you staged), your stash
and your commits are never touched: nothing appears in `git status`, `git log` or
`git stash list`.

The snapshot runs while the model writes its answer; the turn's first tool call waits for
it, so no edit can happen before it is taken. After `timeoutMs` (30 s) the turn goes
on without it, and you are told once. The first snapshot hashes every file, so it is taken
when the session starts and gets much longer (at least 30 minutes); later ones only look at
what changed. When three snapshots in a row run out of time, checkpoints are off for the rest
of the session (raise `timeoutMs`, or add large directories to `.gitignore`).

Files are stored as they are on disk: line endings (CRLF or LF), binary files, file names with
spaces or non-ASCII characters. Attributes such as `text=auto` or `core.autocrlf` do not
apply, so restoring writes back exactly what was there.

In print mode (`amira -p`) Amira exits when the turn ends, so a turn that calls no tool may
end before its checkpoint is written. Nothing is lost by that: such a turn changed no files,
and the next turn's checkpoint holds them.

Turns of sub-agents take no checkpoints of their own; what they change is in the next turn's
checkpoint of the main session.

## Commands

- `/checkpoints`: this session's checkpoints, newest first: number, time, the turn and the
  message that started it, and how many files changed since. `/checkpoints all` counts every
  session's in this repository.
- `/rewind`: pick a checkpoint, look at the diff of what would change, then choose:
  - **Restore files**: the working tree goes back to the checkpoint. Files created since are
    removed; files deleted or renamed since come back.
  - **Restore files and rewind the conversation to before turn N**: the same, and the
    conversation is cut back to before the message that started that turn. The part cut off
    stays in the session file, on a branch of its own. This needs an Amira whose sessions can
    rewind (`SessionControl.rewind`); without it only files are offered.
  - When the files already match, only the conversation is offered.
- `/rewind <n>`: the same for checkpoint `n` without the list.
- `/rewind <n> --files <paths>`: restore only these files or directories (relative to the
  working directory; quote names with spaces). The rest of the working tree stays as it is.
- `--yes` skips the question, e.g. for print mode (`amira -p "/rewind 3 --yes"`);
  `--conversation` with `--yes` also rewinds the conversation.

Every restore first takes a checkpoint of the files as they are (it is listed as
"before restoring #n"), so a rewind can itself be undone: `/rewind <that number>`.
When the restore would replace something no snapshot holds (an ignored or too large file
where the checkpoint has a file of that name, or a directory where it has a file), that is
added to this checkpoint first; when it is beyond the limits below, it is left as it is, and
`/rewind` says so. Files git could not write (on Windows, a file open in another program) are
listed, and the rest is restored.

A rewind waits until the running turn has ended, and until the session's sub-agents running
in the background have too.

## Outside a git repository

In a directory that is not in a git repository the extension keeps a shadow repository of its
own under `~/.amira/checkpoints/<directory name>-<hash>/`, with the directory as its work
tree. Nothing is written into the directory itself. The same snapshots, limits, restores and
pruning apply, and `.gitignore` files are honored there too; on top of them the shadow
repository ignores the usual bulky directories (`node_modules/`, `.venv/`, `target/`, `dist/`,
`build/`, `.cache/` and a few more).

Why a shadow repository rather than copying changed files somewhere: git already does what
checkpoints need (finding what changed quickly, storing each version of a file once, telling
deleted and renamed files apart, keeping bytes as they are), and restoring works exactly as in
a repository. A directory with more files than `maxUntrackedFiles` (for instance a home
directory) is not snapshotted at all; you are told why. Set `"nonGit": "off"` to have no
checkpoints outside repositories.

## Limits and pruning

- Untracked files larger than `maxFileBytes` (5 MB) are left out, and so are the largest
  ones beyond `maxUntrackedBytes` (200 MB) in all. Files you track are always included.
- With more than `maxUntrackedFiles` (2000) untracked files (an unignored `node_modules`, say),
  checkpoints hold only your tracked files, and you are told once; add them to `.gitignore`.
- Each session keeps its newest `keep` (50) checkpoints; older ones are removed as new ones
  come. At startup checkpoints older than `maxAgeDays` (30), of any session, are removed. The
  objects of removed checkpoints go with git's normal garbage collection.

## Settings

In `settings.json`, under `extensions.checkpoints`:

```jsonc
{
  "extensions": {
    "checkpoints": {
      "enabled": true,
      "keep": 50,                 // per session
      "maxAgeDays": 30,
      "beforeTools": false,       // true: also before each edit, write, bash and powershell call
                                  // (only when something changed since the last checkpoint);
                                  // or a list of tool names
      "nonGit": "shadow",         // or "off"
      "timeoutMs": 30000,
      "maxFileBytes": 5000000,
      "maxUntrackedFiles": 2000,
      "maxUntrackedBytes": 200000000
    }
  }
}
```

## Good to know

- The refs are visible to commands that list every ref: `git log --all`, `gitk --all`,
  `git for-each-ref`. `git push --mirror` would push them; ordinary pushes do not. To drop
  them all: `git for-each-ref --format="delete %(refname)" refs/amira/checkpoints | git update-ref --stdin`.
- Submodules are recorded but not restored.
- With git older than 2.40, line endings follow your git settings when snapshotting and
  restoring (git cannot be told to ignore attributes before that).
- Attributes set in `.git/info/attributes` apply to snapshots and restores whatever the git
  version (git reads that file in any case); you are told once when it sets any.
- Git hooks do not run for the extension's git commands, and git settings passed down from
  a git that started Amira (`git -c`, `GIT_CONFIG_*`, `GIT_NAMESPACE`...) do not apply.
- The extension's index and scratch files live in `.git/amira-checkpoints/`: each Amira
  process has an index of its own there (`<pid>-index`), started from the one the last
  process left, so sessions running side by side never wait on each other's locks.
- When checkpoints are turned off for a reason (too many files outside a repository, too
  slow), they stay off until Amira starts again.

## Tests

The tests snapshot and restore temporary repositories (untracked, deleted, renamed, binary and
CRLF files, a repository without commits, a directory without one) and run the extension on a
real agent with a scripted model, so they need Amira's packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
