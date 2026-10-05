Experimental — storage format and behaviour may change

# Memory

Local persistent memory for Amira, version 0.0.2 (requires Amira ^0.1.28). Install with `amira ext install memory`, or load `src/index.ts` with `-e` while developing.

Memory writes stay inside the extension's own data directory, so they don't ask for approval. Plan mode still blocks them.

## What to remember

- Durable user facts and preferences.
- Corrections and confirmed approaches, **with reasons** and how to apply them.
- Non-code project context with absolute dates, such as a confirmed launch deadline.
- Pointers to external resources.

Do not save code structure, past fixes, repository/git information, secrets, one-off requests, or speculative conclusions. Check/read existing memories before saving; replace the same name rather than creating duplicates. Delete wrong or obsolete memories. Verify recalled file, function and flag names against current sources.

Memory text is untrusted model/user data, **not instructions**. Both indexes appear in one stable, replaceable system section, global first, project second. Only retrieval hooks are injected; `memory_read` loads the full fact. The section has no current timestamp and stays unchanged when storage is unchanged. Subagents can read, but cannot save, delete, create directories, acquire locks, or repair indexes.

## Scopes and paths

The host provides the extension's persistent storage root as `api.dataDir` (under the selected `AMIRA_HOME`):

| Scope | Path | Use |
| --- | --- | --- |
| Global | `<api.dataDir>/global/` | Preferences that apply across projects |
| Project | `<api.dataDir>/projects/<key>/` | Context specific to this project |

`git rev-parse --git-common-dir` identifies the main checkout's `.git` directory, so linked worktrees and subdirectories share a project key. Bare/separate git directories use the common directory itself. Without git, the canonical session cwd is used (different non-git subdirectories have different scopes). A key is a readable basename plus a 12-character SHA-256 suffix of the canonical path; Windows identity is case-insensitive. Moving a main checkout changes its key. Identity is pinned per cwd for each extension load so path reports and writes agree even if Git later fails. Hash collisions are very unlikely, not impossible; inspect `/memory path` before manually moving data.

No memory files are written to the repository. A global and project memory may have the same name; neither overwrites the other. Tools require an explicit scope. Named commands default to **project**, never silently fall back to global. Use `--scope global` to select the other copy. List defaults to both scopes.

## Inspect, edit and delete

```text
/memory                         # list both scopes
/memory list --scope global
/memory show release-window
/memory show writing-style --scope global
/memory edit release-window
/memory rm release-window        # TUI confirmation
/memory rm release-window --yes  # explicit consent required in print/RPC
/memory path                     # both scope directories
/memory help
```

The TUI always confirms deletion, even with `--yes`; cancelling does nothing. Print and RPC refuse deletion without `--yes`. These are explicit user commands, not a way for tools to evade approval. A successful tool save/update reports `Remembered: <name> (project)` (or `global`); deletion reports `Forgot: <name> (project)`.

There is no public external-editor handoff API in the linked core. `/memory edit` prints the exact file path and editing guidance; open it in your own editor. Keep valid metadata, update the `updated` date, and keep the name equal to the filename. Manual edits are validated on the next read; invalid or secret-like files are omitted from recall with a warning. Edit while no other memory writers are running; the extension cannot coordinate an arbitrary external editor.

## File format and index

One fact per Markdown file, at most **4 KiB including frontmatter**:

```markdown
---
name: release-window
description: "Confirmed launch window and review lead time"
type: project
updated: 2026-10-05
---

The confirmed launch date is 2026-11-16.

**Why:** The partner review needs two weeks.
**How to apply:** Schedule the review by 2026-11-02.
```

Names are strict lowercase kebab-case, start with a letter, and contain at most 64 characters. Paths, dots, separators, Windows device names, and `memory` (reserved for the index) are rejected. `name` must equal the filename without `.md`. Required metadata is exactly `name`, one-line `description` (up to 240 characters), `type` (`user`, `feedback`, `project`, `reference`), and an ISO `updated` date or UTC timestamp. Writers produce JSON-quoted descriptions (valid YAML strings); manual metadata accepts plain scalars or JSON-quoted strings, not arbitrary YAML. Feedback and project bodies must include nonempty `**Why:**` and `**How to apply:**` sections.

`MEMORY.md` is the authoritative discovery index with entries `- [name](name.md) — description`. It is generated deterministically from valid files, newest first, then name. Saves, replacements and deletions update it under a per-directory cross-process lock. Missing, stale or damaged indexes are reconstructed **in memory** on reads; only the next authorized mutation persists the repair. Reads never rewrite disk, even for the main session. The full on-disk index is retained; injection is capped at 200 lines / 8 KiB **per scope**, keeping newest hooks and a consolidation note when entries are omitted. `/memory list` shows all valid entries.

Writes use exclusive lock-directory creation, private deterministic temporary files (`.<name>.md.tmp` and `.MEMORY.md.tmp`), file sync and atomic rename. Both writing tools report every affected directory, memory file, index, lock and temporary path to the host. The public mutation hook captures file changes for rewind without trying to capture directory or lock images. Readers see complete files, never a partially written index. A crash between the memory rename and index rename can leave a stale index; read-time reconstruction handles it. Multi-file changes are not a transactional filesystem snapshot. An abandoned `.memory.lock` is never stolen based on age: after a crash, stop all writers, inspect `/memory path`, then remove only that scope's empty `.memory.lock` directory and abandoned temporary files. Existing temporary files are never overwritten. A lock wait times out safely after 15 seconds. Symlink/junction directories below and at `api.dataDir`, and linked/non-regular memory/index files, are refused. This is not protection against a malicious process already controlling your local filesystem.

## Privacy

Storage is local plaintext, not encrypted or synced by this extension. It is outside the repository, but your normal home backups may include it. Index descriptions are sent to the selected model; full bodies are sent when read. Do not put secrets in either. Known key/token formats, private keys, credential assignments, and long high-entropy strings are rejected with a safe error that does not repeat the input. This heuristic can have false positives and cannot detect every secret. A secret already submitted in a tool call can still exist in the host's transcript; refusal prevents storing it as memory, not retroactive transcript redaction. Delete files and any backups/transcripts yourself when needed.

## Development and offline demo

TypeScript imports only `@amira/api` and Node/Bun builtins. Core is used as an executable in integration coverage, not through private imports. `src/index.ts` exports only the default extension; its export surface has a snapshot test.

```sh
bun install
bun run link-amira D:/dev/Amira
bun run typecheck
bun run lint
bun test --timeout 120000
bun run demo D:/dev/Amira
```

The demo and integration tests create a temporary `AMIRA_HOME` and cwd, disable automatic titles and network catalog downloads via the offline mock, and remove their temporary directories afterward. The demo uses the default permission mode and fails on any approval request; integration coverage also verifies that plan mode refuses writes. It saves a fact with `memory_write`, makes the next model turn, prints the actual injected index, and runs `/memory list`, `show`, `edit`, `path`, and `rm --yes`. No API keys or real Amira home are needed. Set `AMIRA_TEST_CORE` to use another linked core checkout for tests.
