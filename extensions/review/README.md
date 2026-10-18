# Review — experimental 0.2.0

Bounded independent **static** code review with `/code-review`. Normal review uses two fresh schema
reviewers over the same sanitized change bundle: correctness/security and contracts/tests/documented
standards. Optional `--deep` adds directory/size groups through workflow's owner-bound runner while
retaining both full-bundle lenses. At most one fresh verifier assesses the merged, validated,
deduplicated findings. No test execution or automatic edits. `/review` remains share's command;
this package neither overrides nor imports share.

## Installation and compatibility

```sh
amira ext install review
```

Requires Amira public API **^0.1.56**, the first inspected API exposing all owned-conversation,
permission-checked `runTool`, group/schema, private tool, artifact, settings and view capabilities
used here. Runtime capability checks remain fail-closed. The host's owned-interface source still
contains a publication-bump caveat: test against the 0.1.56 checkout and reconcile that host release
before publishing. This extension does not change the host version. Unknown configured models fail
before children start. Normal review has no dependency on another optional extension. `--deep`
requires the optional structural **`workflow.runner` 0.3.1** contract described below; review does not
import workflow implementation code.

## Commands and exact scopes

```text
/code-review [--deep]
/code-review worktree [--deep] [--path P ...] [--include-untracked] [--no-verify] [--yes]
/code-review since REF [--deep] [--path P ...] [--no-verify] [--yes]
/code-review pr NUMBER_OR_URL [--deep] [--path P ...] [--no-verify] [--yes]
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
- **PR NUMBER_OR_URL:** accepts a positive PR number (resolved by `gh` from the local repository) or
  a canonical `https://github.com/OWNER/REPO/pull/NUMBER` URL, without a query, fragment or trailing
  slash. Requires an accessible local Git repository and an already-installed, authenticated GitHub
  CLI. The collector uses owned, permission-checked `gh pr view REF --json
  number,url,headRefOid,baseRefOid` and `gh pr diff URL --color=never`, checking metadata before and
  after collection. No checkout, fetching, worktree creation, posting or `--post` option. Authentication
  setup happens outside review; the extension does not sign in for you.
- **Path filters:** repeat repository-relative literal file/directory filters, e.g. `--path src`.
  Quote spaces or apostrophes using the other quote style. No glob, regex, arbitrary Git pathspec,
  absolute/traversing paths, leading options or line breaks. No automatic default branch discovery or
  arbitrary ranges/historical targets. For PRs the complete remote diff must fit the raw patch cap
  **before** path filtering, so `--path` cannot admit an oversized remote diff.

Examples:

```sh
# Net tracked changes, with a narrower context scope
/code-review worktree --path src
# Explicit opt-in: also expose new non-ignored text in this subtree
/code-review worktree --include-untracked --path src
# Committed changes only; clean tracked checkout required
/code-review since HEAD~1 --path src --path test
# Optional workflow-backed fan-out over a larger admitted local change set
/code-review worktree --deep --path src
# Remote PR diff only; no unrelated local source context or posting
/code-review pr 123 --deep --path src --no-verify
/code-review pr https://github.com/OWNER/REPO/pull/123 --yes
# Print-mode command (passed using the host's normal print input mechanism)
/code-review worktree --path src --yes
```

Print mode requires an explicit scope and `--yes`, waits, and prints the **complete Markdown report**.
**Shell permissions may still deny execution**, especially when approval is unavailable. `--yes`
consents to the documented model exposure; it never grants shell permissions or changes policy.
TUI/RPC runs preflight in the command, then returns while admitted model work runs. No queue; one run
per loaded extension. `last`/`show` reopen saved data without a model call or Git collection.

## Deep review and optional workflow service

Use `--deep` with `worktree`, `since REF` or `pr NUMBER_OR_URL`. Interactive `/code-review --deep`
opens the scope chooser and retains deep mode; print mode requires an explicit scope.
Review discovers `api.useService("workflow.runner")` structurally: all five capabilities **`cwd`, `freshRun`, `models`,
`ownedLifetime`, `progress` must equal `true`**, and all six methods **`available`, `startBound`,
`status`, `stop`, `onProgress`, `onResult` must be functions**. It requires **`available() === true`**
at mode admission and again at launch, and rechecks availability/service identity during the run.
A version string alone is not admission. The provider's availability query is pure and does not
bypass workflow settings, start confirmation or budgets.

If the runner is absent, incompatible or unavailable before starting, interactive use offers
**Review normally** or **Cancel**. Normal review requires that explicit fallback approval and its
usual exposure consent (or an already-supplied `--yes`); it retains normal admission caps. Print mode
starts nothing and tells you to retry manually **without `--deep`**, retaining your scope and other
options. There is never a silent downgrade. A launch failure, replacement, disable or unload during
deep work fails/stops that run rather than substituting normal review.

Deep packing sorts by directory and path, then uses size-bounded first fit, preferring a fitting
group containing the same directory. Each group has at most **32 files, 2,000 added + removed lines,
64 KiB combined patch**, with a **32 KiB single-file patch** cap. It refuses an indivisible file or
more than **12 groups**; it does not truncate. One reviewer per group plus **two independent
full-bundle lenses** produces at most 14 review tasks, six findings each: **84 candidates** before
validation/deduplication. At most **one existing batched verifier**, outside the fan-out script,
assesses the merged, validated, deduplicated list when enabled and budget remains. `--no-verify`
disables it; no verifier per group is added. The deep assessor schema sizes its rationale allowance
against the merged candidate count to keep the whole response within **32 KiB**, including JSON
escaping and up to four 200-character limitations. Large batches require brief rationales; oversized
or missing assessments still remain unchecked.

Review supplies a wrapped owned group to `startBound` and overrides every workflow group spawn:
only approved task prompts, the captured reviewer model/cwd, fresh context, fixed policy/schema,
empty ordinary tools and write roots, and child-only `review_read`, `review_search`, `return_result`
are allowed. Workflow's script sandbox or a reviewer role alone is **not** this privacy boundary.
Deep execution is capped at **six concurrent reviewers**, further constrained by workflow admission,
host tree limits and review token/cost budgets; the normal `maxParallel` setting remains 1–2.
The verifier uses only the remaining review budget. The ten-minute execution deadline still applies.

Service **`onProgress`** snapshots feed review child states/status and the host-scrolled deep
progress view. Interactive deep runs open it when the frontend supports views; closing it leaves
execution running. `/code-review status` remains the text fallback. Cancellation calls runner
**`stop(runId)`** and stops owned work. A terminal `status` or progress
snapshot is not settlement: review waits for **`onResult`** before accepting the batch, then drains
its groups/children and releases its owner. No resume/replay is offered by review.

## Preflight, privacy and coverage

Every Git operation (including probes/freshness) runs through an inert extension-owned conversation's
permission-checked shell tool. The owner never receives a model turn. Collection disables pager,
external diff/textconv, rename detection, fsmonitor, lazy fetching and transports; it has a two-minute
wall deadline (including unanswered approvals) and 30-second Git-call timeouts. A cancelled/denied
approval is not a model-exposure yes and is not retried through raw process APIs. PR collection
likewise uses the owned host shell tool: **the extension makes no direct network requests**, but the
user-approved host tool may run `gh`, which contacts GitHub. Permission approval and model-exposure
consent are separate. Development and verification remain offline; they do not contact GitHub.

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

The PR collector has a narrower context boundary: only the sanitized **remote diff**, not complete
remote source or unrelated local checkout snapshots. Its approved inventory is empty, so local
`review_read`/`review_search` context and repository guidance are unavailable. Redaction works over
old/new projections of the remote diff; secrets outside that diff cannot be inspected. Local editable
templates still apply. Do not interpret PR commit IDs as proof that the local checkout matches.

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
| Selected changed files (tracked + admitted untracked for local scopes) | Normal: 32; deep total: 128 |
| Added + removed lines | Normal: 2,000; deep total: 8,000 |
| Complete combined / single-file UTF-8 patch | Normal: 64 KiB / 32 KiB; deep total: 256 KiB / 32 KiB |
| Deep group | 32 files / 2,000 added + removed lines / 64 KiB patch; at most 12 groups |
| Repository guidance / local editable templates | 16 KiB each total |
| Approved path inventory | 10,000 paths or 1 MiB |
| Complete old/new source for privacy collection | 64 KiB per side, 256 KiB total |
| Additional source snapshots | 16 files, 64 KiB/file, 256 KiB total |
| Reader response | 200 lines / 8 KiB, explicit continuation |
| Reader calls per child | 24, including repeated reads and search calls |
| Search per child / per call | 8 calls / 50 results |
| Findings per reviewer / total candidates | 6 / normal: 12; deep: 84 |
| Child result domain size | 32 KiB |
| Normal run | 2 reviewers + at most 1 batched assessor; concurrency 1–2; ten minutes |
| Deep run | At most 12 group reviewers + 2 full-bundle lenses + 1 batched assessor; concurrency at most 6; ten minutes |
| Terminal reports per repository | 20 |

Deep raises the combined file/changed-line/patch caps and matching report metadata limits, **not the privacy-source cap**: complete
local old/new privacy sources remain **64 KiB per side, 256 KiB total for the entire run**, not per
group. The additional snapshot pool also stays shared at 16 files / 256 KiB total. A small patch over
large complete sources can still fail admission. Normal review never automatically splits large
changes; deep grouping does not admit arbitrary historical ranges. Shell capture of extreme metadata
output is a host/process limitation, not a hard memory guarantee. Budgets stop on observed usage, not provider
reservations; an in-flight request may overrun. Prompt bytes are not exact tokens or a dollar quote.
Unknown/missing reported cost stays unknown, not zero. Reported group usage is counted once.

## Settings

Flat fields in the host's extension settings UI; captured at run start (later edits affect new runs).

| Key | Default | Bounds / meaning |
|---|---|---|
| `reviewerModel` | empty | Capture main model; otherwise enabled `provider/model` |
| `verifierModel` | empty | Independently capture main model; explicit override allowed |
| `verify` | true | One batched independent static refutation pass; `--no-verify` disables |
| `maxParallel` | 2 | Normal review: integer 1–2, subject to host tree admission; deep uses a fixed upper bound of 6, subject also to workflow limits |
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
is no fix-all, auto-fix, editor/clipboard integration or public review runner service. **PR findings
cannot be handed off to an unverified local checkout**: `fix` is blocked for PR reports. Review a
matching local change set first; the extension does not fetch/check out a PR or infer checkout identity.

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

**Deep mode and workflow:** `--deep` runs through the workflow extension, which keeps its own run
arguments and journals (including the sanitized group prompts) under its data directory. Pruning
review reports does not remove those; manage them with the workflow extension.

## Offline development and verification

Use an already-prepared host checkout and local toolchain (no dependency downloads needed for tests):

```sh
bun run link-amira <path-to-your-Amira-checkout>
bun run typecheck
bun run lint
# From extensions/review, use a fresh Bun process for each test file:
for file in test/*.test.ts; do bun test "$file" || exit; done
```

Do not combine all files into one `bun test` process: host/module mocks and disposable home state
must not leak between files. The loop above is Bash syntax; in PowerShell, use a fresh `bun test`
invocation for each file and stop on a nonzero exit code. These are maintainer instructions, not
commands executed as part of this documentation update.

Tests use fake hosts, scripted schema children/dialects and temporary local Git repositories, with
only disposable `AMIRA_HOME`. No live API calls, network, GUI, installed user state or project commits.
Mock UI contracts cover Enter/action fallback and view/text behavior. Headless terminal walkthroughs
use the host's `scripts/ui-walk start --extension` in isolated temporary state; screen-reader and
assistive-technology behavior still require maintainer dogfooding and are not certified by mocks.
