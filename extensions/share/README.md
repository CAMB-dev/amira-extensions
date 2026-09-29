# share

Session export and git helpers for Amira:

- `/export` writes the session as Markdown or as one self-contained HTML file;
- `/commit` proposes a commit message for what is staged, and commits once you agree;
- `/pr` drafts a pull request for the branch and, with `gh`, opens it;
- `/review` has a reviewer sub-agent review the branch and prints its findings.

```sh
amira ext install share
```

Needs Amira's extension API 0.1.2 (for `SessionControl.readSession`, which `/export` uses to
read the whole conversation and `/export --session <id>` to read a stored one).

## /export

```
/export [md|html] [path] [--session <id>] [--force]
```

- With no path, the file goes to `.amira/exports/<session>-<date>-<time>.<md|html>` in the
  project. When that directory is created, it gets a `.gitignore` of `*`, so exports are not
  committed by accident. A path ending in `/`, or naming a directory, gets the same file name
  inside it. A path ending in `.html` or `.md` sets the format; a path without an extension
  gets the format's.
- A file that exists already is replaced only once you confirm (`--force`: without asking;
  where nobody can answer, as in print mode, it is left alone).
- Without `md` or `html` (and no telling extension), the format is `exportFormat` (default
  Markdown).
- `--session <id>` exports a stored session of this project (the ids `/resume` lists)
  without switching to it. Tab completes the ids.

Both formats have the whole conversation, including anything a compaction later summarized:

- your messages (a command or skill shows what you typed, with the full text folded under it);
- replies, with thinking folded;
- every tool call as a collapsed block with its arguments and its result (failed ones are
  marked);
- sub-agents, each in a section of its own (role, status, model, tokens, time, task, and its
  own conversation), linked from the tool call that started it;
- notices, such as a background sub-agent's report.

The HTML file needs nothing else: styles and a few lines of script (expand or collapse
everything) are inline, images are embedded, and it follows the system's light or dark mode.
Everything the session said is escaped: no text from the session becomes markup, and links
keep only `http(s)`, `mailto` and relative targets (not `//host/…`, which opens as a network
path from a local file). Markdown exports name images instead of
embedding them.

**Secrets.** Before anything is written, text that looks like a key or token is replaced
with `[REDACTED]`: keys by their usual shapes (`sk-…`, `ghp_…`, `github_pat_…`, AWS, Google,
Slack, Stripe, Hugging Face, npm, Telegram bot tokens, Google OAuth tokens, Azure storage keys,
JWTs, private key blocks, webhook URLs), `Bearer …` and `Basic …` headers, passwords in URLs,
`api_key = …` / `"token": "…"` / `PRIVATE_KEY=…` assignments with generated-looking values,
password assignments of 8 characters or more, and the values of this process's environment
variables whose names have a KEY, TOKEN, SECRET, PASSWORD, CREDENTIALS or AUTH part (when
the value looks generated) and of every provider's `apiKeyEnv`, wherever they appear. It is a filter, not a guarantee: read an export before you share it.

## /commit

```
/commit [--yes] [what the change is about]
```

1. Reads the staged diff (`git diff --cached`); with nothing staged it says so and stops.
2. Asks the model once for a subject and a body (a sub-agent with no tools that must hand
   back that structure), with the staged diff, the recent subjects for style, and your note
   if you wrote one.
3. Shows the proposal and asks: **Commit**, **Edit message** (a form with the subject and
   body), or **Cancel**.
4. Commits with plain `git commit --file <message>`: your hooks run and your signing settings
   (`commit.gpgsign`, `user.signingkey`) apply, as they would in a terminal. A failing hook is
   reported with its output, and the message is printed so you can reuse it.

If the staged changes change while you read the proposal, nothing is committed. `--yes`
commits without asking, and is the only way to commit where nobody can answer a dialog
(print mode).

Conventional Commits (`feat(scope): …`) follow `conventional`: by default the model uses
them when most of the repository's recent subjects do.

## /pr

```
/pr [base] [--draft] [--yes]
```

Drafts a title and description from the branch's commits and its diff against the base
(the merge base, so commits that landed on the base since are left out), following the
repository's pull request template when it has one. The base is the argument, else `base`
from the settings, else `origin`'s default branch, else `main` or `master`.

- Without [`gh`](https://cli.github.com/), it prints the draft, ready to paste.
- With `gh`, it asks whether to open the PR (**Create PR**, **Edit…**, **Cancel**). A branch
  with no upstream, or with commits not pushed, is pushed first (`git push --set-upstream`,
  never forced), and the question says so. Then `gh pr create` opens it and the URL is
  printed. `--draft` opens a draft; `--yes` skips the question.

## /review

```
/review [base]
```

A reviewer sub-agent reviews the branch's changes against the base (chosen as for `/pr`).
When the branch has no commits of its own, it reviews the uncommitted changes instead. It
gets the commits and the diff, may read the code around them (read, grep and glob only, as far as the
session has those tools: no shell, since the diff may come from someone else), and hands back findings, which are
printed most severe first: severity, `file:line`, the problem, and how it goes wrong. It
runs on `reviewModel`, else `agents.reviewer.model`, else the session's model.

The commands run alongside the conversation: you can keep typing while the model drafts or
reviews. The sub-agent they start is an ordinary one of the session, so `/agents` lists it and
`/agents stop` stops it.

## Settings

In `settings.json`, under `extensions.share`:

```jsonc
{
  "extensions": {
    "share": {
      "exportDir": ".amira/exports",  // where /export writes without a path
      "exportFormat": "md",           // "md" or "html"
      "model": "deepseek/deepseek-chat", // for /commit and /pr; default the session's model
      "reviewModel": "provider/model",   // for /review
      "conventional": "auto",         // true, false, or "auto" (follow the repository)
      "base": "main",                 // the branch /pr and /review compare with
      "maxDiffChars": 120000          // diff sent to the model; the rest is listed by file
    }
  }
}
```

## How it works

Everything goes through `@amira/api`: git and gh run through `runCommand` (off the main
thread, with their whole process tree killed on timeout), and the model is reached through a
sub-agent of the session (`createGroup` + `spawn` with a result schema), so the call shows
up where the frontend shows sub-agents, in full-screen and inline mode alike. Nothing is sent
anywhere except to the model you configured, and to GitHub only by `git push` and
`gh pr create` after you agree.

## Tests

The tests run the commands against temporary git repositories, with a real extension host
and agent tree on a scripted model, so they need Amira's packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
