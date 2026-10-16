# Review — experimental 0.1.0

Bounded independent **static** code review with `/code-review`. Two fresh schema reviewers inspect
the same sanitized change bundle: correctness/security and contracts/tests/documented standards.
One optional fresh agent assesses the combined candidate list. No test execution or automatic edits.
`/review` remains share's command; this package neither overrides nor imports share.

## Installation and compatibility

```sh
amira ext install review
```

Requires Amira public API **^0.1.56**, the first inspected API exposing all owned-conversation,
permission-checked `runTool`, group/schema, private tool, artifact, settings and view capabilities
used here. Runtime capability checks remain fail-closed. The host's owned-interface source still
contains a publication-bump caveat: test against the 0.1.56 checkout and reconcile that host release
before publishing. This extension does not change the host version. Unknown configured models fail
before children start. No dependencies on other optional extensions.

## Commands and exact scopes

```text
/code-review
/code-review worktree [--path P ...] [--include-untracked] [--no-verify] [--yes]
/code-review since REF [--path P ...] [--no-verify] [--yes]
/code-review status
/code-review stop
/code-review last
/code-review show F001
/code-review ignore F001
/code-review fix F001
```

- **Worktree:** net tracked HEAD → working-tree content, including staged additions/deletions and
  unstaged edits. Staged intermediate content that cancels out in the working tree is not a second
  patch. Never-added files are excluded unless `--include-untracked` explicitly admits non-ignored
  untracked regular text. Admitted untracked paths are listed separately in preflight and reports,
  under the same privacy rules and combined caps. Ignored files remain excluded.
- **Since REF:** resolve one local ancestor to a commit OID, pin captured HEAD, compare those trees.
  Tracked index/worktree must be clean. No merge-base substitution or working-change ingestion.
  Untracked files are never included in this scope. Detached HEAD is supported; unborn HEAD and an
  unmerged index are explicitly unsupported.
- **Path filters:** repeat repository-relative literal file/directory filters, e.g. `--path src`.
  Quote spaces or apostrophes using the other quote style. No glob, regex, arbitrary Git pathspec,
  absolute/traversing paths, leading options or line breaks. No automatic default branch discovery,
  arbitrary ranges/historical targets, PR APIs, fetching or worktree creation.

Examples:

```sh
# Net tracked changes, with a narrower context scope
/code-review worktree --path src
# Explicit opt-in: also expose new non-ignored text in this subtree
/code-review worktree --include-untracked --path src
# Committed changes only; clean tracked checkout required
/code-review since HEAD~1 --path src --path test
# Print-mode command (passed using the host's normal print input mechanism)
/code-review worktree --path src --yes
```

Print mode requires an explicit scope and `--yes`, waits, and prints the **complete Markdown report**.
**Shell permissions may still deny execution**, especially when approval is unavailable. `--yes`
consents to the documented model exposure; it never grants shell permissions or changes policy.
TUI/RPC runs preflight in the command, then returns while admitted model work runs. No queue; one run
per loaded extension. `last`/`show` reopen saved data without a model call or Git collection.

## Preflight, privacy and coverage

Every Git operation (including probes/freshness) runs through an inert extension-owned conversation's
permission-checked shell tool. The owner never receives a model turn. Collection disables pager,
external diff/textconv, rename detection, fsmonitor, lazy fetching and transports; it has a two-minute
wall deadline (including unanswered approvals) and 30-second Git-call timeouts. A cancelled/denied
approval is not a model-exposure yes and is not retried through raw process APIs.

Before children start, preflight lists selected/excluded/redacted paths, scope, guidance, prompt size,
models, agents and budgets. Reviewer/assessor scope metadata uses the resolved base OID, not the supplied
ref name; the exposure preview uses the same sanitized scope fields. Ref resolution and freshness
checks retain their separate operational inputs. Prepared reviewer prompt bytes are calculated from
the same sanitized text that is submitted, including separators (excluding host schema/envelope).
Oversized input is refused, never silently clipped. Narrow the scope with repeated `--path`;
filtering can hide cross-subtree defects. Binary, generated/vendor/lockfiles,
submodules, symlinks/junction escapes, hard-linked content, Git metadata, unsupported paths and
secret-bearing paths are excluded. Metadata-only changes are identified but may have no assessable
text. Common credentials/private-key shapes are replaced with line-preserving markers everywhere
submitted or shown (diffs, source, guidance, findings, saved excerpts and fix prompts).
Collection sanitizes complete bounded old/new source before projecting it onto hunk coordinates;
PEM boundaries outside a hunk still protect the key body. Unlocatable Git function-context hints
are omitted. Long base64 body fragments are also redacted without needing PEM boundary lines,
including in context tools, model diagnostics, saved reports and hand-off text. Missing, oversized
or mismatched complete source stops the run before any reviewer starts; even a small patch can
therefore require narrowing or deferral. Host Git evidence can retain the raw complete source locally.
**Detection is best effort, not a guarantee that arbitrary source contains no secrets.**

Children have no shell, network, generic read/grep/glob, delegation or writes. Child-only
`review_read({path, offset?, limit?})` serves approved bounded sanitized immutable snapshots.
`review_search({query, path?, maxResults?})` performs **literal, case-sensitive substring** search in
approved tracked/admitted-untracked text within scope, returning `path:line: excerpt`. There are no
regex/glob switches, Git metadata access, outside-scope files or URL/include following. Search uses
those same cached sanitized snapshots; incomplete context is a limitation, not unlimited discovery.
The allowlist is an application boundary, not an OS sandbox.

### Fixed admission and execution caps

| Resource | Maximum |
|---|---|
| Selected changed files (tracked + admitted untracked) | 32 |
| Added + removed lines | 2,000 |
| Complete combined / single-file UTF-8 patch | 64 KiB / 32 KiB |
| Repository guidance / local editable templates | 16 KiB each total |
| Approved path inventory | 10,000 paths or 1 MiB |
| Complete old/new source for privacy collection | 64 KiB per side, 256 KiB total |
| Additional source snapshots | 16 files, 64 KiB/file, 256 KiB total |
| Reader response | 200 lines / 8 KiB, explicit continuation |
| Reader calls per child | 24, including repeated reads and search calls |
| Search per child / per call | 8 calls / 50 results |
| Findings per reviewer / total candidates | 6 / 12 |
| Child result domain size | 32 KiB |
| Run | 2 reviewers + at most 1 batched assessor; concurrency 1–2; ten minutes |
| Terminal reports per repository | 20 |

Large/historical changes are not split or fanned out. Shell capture of extreme metadata output is a
host/process limitation, not a hard memory guarantee. Budgets stop on observed usage, not provider
reservations; an in-flight request may overrun. Prompt bytes are not exact tokens or a dollar quote.
Unknown/missing reported cost stays unknown, not zero. Reported group usage is counted once.

## Settings

Flat fields in the host's extension settings UI; captured at run start (later edits affect new runs).

| Key | Default | Bounds / meaning |
|---|---|---|
| `reviewerModel` | empty | Capture main model; otherwise enabled `provider/model` |
| `verifierModel` | empty | Independently capture main model; explicit override allowed |
| `verify` | true | One batched independent static refutation pass; `--no-verify` disables |
| `maxParallel` | 2 | Integer 1–2, also subject to host tree admission |
| `maxTokens` | 120000 | Positive integer, at most 240000 group tokens |
| `maxCostUsd` | 2 | Positive reported-cost budget, at most USD 10 |

No setting disables permission checks, redaction or the fixed file/time/agent caps.

## Findings, cancellation and hand-off

Priority **P1/P2/P3** is separate from assessment: **supported**, **uncertain**, **refuted**, **unchecked**.
Supported means an independent static agent found the failure plausible under its assumptions,
**not tested, reproduced or proven**. Failed/missing assessment stays unchecked. Refutations and
duplicate links remain in the report and can be expanded in the picker. A failed/partial review never
means “no issues found”; even a clean completed report is not an acceptance gate.

`last` opens the native findings picker. Enter opens an action menu (works without section shortcut
support): detail view, print, ignore/unignore, or hand off one finding. Details are read-only and
host-scrolled; unavailable views fall back to complete text. Ignore applies only to that report; editing an older open report never republishes it as latest.
Completion prints a display-only saved summary; it never steals focus or starts main automatically.

`status` shows collecting/reviewing/assessing/stopping and child states. `stop`, origin-session
end/switch, deadline, budget termination and unload cancel work, drain the group and release the
owner. Owned children are not ordinary `/tasks` entries. Cancellation saves validated partial work;
no restart/resume after reload. Interrupted running checkpoints are shown as partial, not replayed.
Concurrent source edits mark reports stale; filesystem checks are not transaction isolation.

**`fix F001` is explicitly mutating:** it previews the exact sanitized single-finding prompt and asks
before sending to the idle current main session. It requires the same canonical worktree and fresh
scope/context fingerprint, then rechecks identity/busy state immediately before one `send`. Main is
asked to reassess, make the smallest justified fix, run relevant checks and not commit. This starts a
model turn, not a composer draft. The extension does not edit code or declare a finding fixed. There
is no fix-all, auto-fix, editor/clipboard integration or public runner service.

## Guidance, storage and retention

Edit local Markdown under `templates/` to tune the two reviewers and assessor. Sizes are bounded and
hashes saved. Package updates can replace installed templates: use repository **`REVIEW.md`** for
durable project criteria. Applicable `AGENTS.md`/`CLAUDE.md` are read by deterministic ancestor
traversal within scope, not recursive crawling. Oversize guidance fails closed rather than silently
truncating rules. No executable prompt plugins, `.amira/review.md` alternative or online standards.

Versioned atomic reports live in `api.dataDir/repos/<canonical-worktree-hash>/runs/<run-id>.json` with
an atomic `last.json` pointer advanced only after a terminal save. A small running record precedes
spawning; validated results checkpoint at phase boundaries. Reports save short sanitized excerpts,
source hashes and limitations, **not raw patches, source snapshots, environment or conversations**.
Pruning keeps at most 20 terminal reports per repository and only removes validated owned files.
Persistence errors are visible and do not replace the previous last report. No automatic export into
source control; reports are not a secret vault.

**Separate host persistence:** Git operation evidence/artifacts can retain raw collection output
locally before sanitization. Owned sessions and submitted child transcripts follow normal host and
provider retention policies. Releasing owners or pruning extension reports does not delete those
host-managed histories. This package never reaches into home to remove them or promises zero retention.

## Offline development and verification

Use an already-prepared host checkout and local toolchain (no dependency downloads needed for tests):

```sh
bun run link-amira <path-to-your-Amira-checkout>
bun run typecheck
bun run lint
bun test
```

Tests use fake hosts, scripted schema children/dialects and temporary local Git repositories, with
only disposable `AMIRA_HOME`. No live API calls, network, GUI, installed user state or project commits.
Mock UI contracts cover Enter/action fallback and view/text behavior. Headless terminal walkthroughs
use the host's `scripts/ui-walk start --extension` in isolated temporary state; screen-reader and
assistive-technology behavior still require maintainer dogfooding and are not certified by mocks.
