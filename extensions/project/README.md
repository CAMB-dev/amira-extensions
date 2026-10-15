# Project (experimental)

Project discovery, a persistent design conversation, an auditable record of **human** decisions, and iteration state with human-confirmed stage gates. This batch adds the **state, artifacts and gates** for design → prototype → implementation → acceptance. Prototype generation, implementation/spec execution, automated acceptance, shipping, budgets, dashboard integration and archive workflows are **not available yet**. Advancing a stage never starts those operations.

Requires Amira extension API **0.1.52** (owned conversations arrived in 0.1.51; native conversation focus in 0.1.52). No workflow, swarm, btw or dashboard dependency.

## Commands

Run commands from the **main** conversation:

| Command | Action |
| --- | --- |
| `/project` or `/project list` | Choose from previously opened projects plus the nearest discovered project. No disk scanning. |
| `/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]` | Create and attach a project. Without a name, ask for one. Default directory: current working directory. Quote names/directories containing spaces. |
| `/project switch [name, id, or directory]` | Attach a known/discovered project, or open an explicit directory. Without an argument, show the picker. Duplicate names require an ID or directory. |
| `/project status` | Show attached directory, iteration, real stage/status, pending approval, manual-trial status, and accepted/skipped/unresolved batches of the pinned plan. |
| `/project next` | Show the current saved summary and proposed next step; ask you to confirm, choose an alternative or skip. A batch pass proposes fresh approval of the next batch, not overall completion. No execution starts. |
| `/project skip <stage>` | Ask you to explicitly skip the current stage (`design`, `prototype`, `implement`, `accept`). Skipping acceptance lists and records every remaining pinned-plan batch as skipped, not passed. |
| `/project skip batch` | From a non-running pinned implementation or acceptance boundary, explicitly skip the current batch. Interrupt running work first. Its receipt identifies the exact plan/batch; remaining work still needs human approval. |
| `/project revisit design\|prototype` | Return to an earlier stage without resetting changes. During implementation/review, choose interruption or waiting until the batch finishes. |
| `/project design` | Open this project's saved design conversation for the current iteration. |
| `/project help` | Show command help and the batch boundary. |

Example: `/project new "Local planner" --root "./work/planner" --language en`.

**Attaching is metadata-only:** the main conversation's working directory does not change. The design conversation and research children use the selected project directory. One project is attached per main session. Attachments follow that session's branch (including resume/fork/rewind); the latest snapshot wins. An attachment receipt is persisted even before the first model prompt. Memory-only hosts cannot promise next-run attachment persistence.

The panel above the input shows name, iteration, the persisted stage/status and the next-step suggestion. It does not infer approval from tool completion or start work while rendering. Before opening design it says “Open design conversation.” Once a design runtime is available it uses a neutral continuation/F6 return hint, not a command to open the conversation again. Host panels receive the main session ID even during native design focus, so the extension does not claim to infer focus from that ID. The host's native focus indicator identifies the actual composer target. The normal panel-collapse control leaves the summary line visible. Missing/invalid status appears before long paths in picker labels; the extension never silently substitutes a nearby project.

## Discovery and files

The nearest ancestor containing `.amira/project.json` wins, including nested projects inside one repository. A malformed nearest marker is an error, not permission to fall back to an outer project. An explicit switch resolves its directory/registry identity independently of cwd discovery, so you can recover by switching to a healthy project. Lists retain healthy registry entries alongside a visible discovery warning. A directory has exactly one project marker. The registry in the host-assigned extension `dataDir` only remembers projects opened before; it never scans search roots or your disk. Registry writes publish independent immutable transactions in `registry.entries/`, so different Amira processes cannot lose each other's read–modify–write updates. Legacy registry snapshots are still read. Healthy explicitly reopened locations outrank stale same-ID locations even if the wall clock moved backwards; stale identities remain visible when no healthy location exists.

```text
<project>/
  .amira/
    project.json              # schema version, stable ID, name, created time,
                              # currentIteration, settings.language/commitDocuments
    project/
      design.md               # model-maintained design document
      decisions.md            # generated human-confirmed ledger, including history
      suggestions.md          # unconfirmed model proposals, never decisions
      research/               # generated filenames for research notes
      iterations/1/
        state.json            # recoverable stage state, revision, approvals, skips, artifact links
        .state/               # authoritative immutable, hash-chained revision records
        artifacts/            # <closed-kind>-<generated-UUID>.json with identity + payload
        .writer.lock          # transient iteration writer claim; dead-process claims recover
                              # retained .preserved versions may remain after publication
      decisions.evidence.jsonl # authoritative human-answer records (created on first answer)
      decisions.manifest.json  # acknowledged generated Markdown hash
      decisions.generated.md  # conflict-only projection; never overwrites hand edits
```

Creation preserves existing `.gitignore` content and appends `.amira/project/` unless `--commit-documents` is selected. The marker is not ignored. Changing `settings.commitDocuments` later does not remove an existing ignore rule; review `.gitignore` yourself if you decide to commit the documents.

The extension writes only its fixed documents, evidence and generated research-note filenames. Canonical root, ancestor and output-directory identities are pinned when a project is captured, then checked again before writes and publication. Replacing a root or captured ancestor with a junction is rejected even if the redirected tree contains the same project marker. Traversal and symlink/junction escapes are rejected. External output directories are not supported in this batch. These are application safeguards, **not an OS sandbox**: portable Node APIs cannot eliminate the last kernel-call race against a hostile process continuously swapping directories. Allowed read tools may read outside the project according to host permissions.

## Iteration stages and approval gates

State lives in `.amira/project/iterations/<n>/state.json`, not the host session database. It records `schemaVersion`, monotonic `revision`, project/iteration identity, stage (`design`, `prototype`, `implement`, `accept`), status (`idle`, `working`, `awaiting-confirmation`, `interrupted`, `blocked`), skips, human approval receipts and immutable artifact links. Opening an old batch-one project creates **design / idle** state lazily; it never rewrites old documents or decision evidence. Reopening state is inert: it never replays a launch.

The reducer keeps these events separate: **work finished → summary prepared → transition proposed → human confirmed → next stage started**. A model recommendation or a tool finishing is not approval. Proposals are saved before a human dialog, and receipts bind the exact project, iteration and state revision. Implementation/review authorization also pins the **spec revision/hash and immutable batch-plan artifact ID/hash**, batch ID and mode (plus the implementation model). Batch membership is resolved only from that pinned plan, never from the newest plan or any plan with the same batch label. Publishing a replacement plan invalidates an idle confirmed launch authorization; a new summary and same-stage `reapprove` proposal require fresh human confirmation. Plan replacement is refused while work or approval is in progress. Dismissing a dialog creates no approval receipt. If anything changes while a dialog is open, the stale answer fails; review the new state and confirm again. The state store serializes writers, uses a cross-process claim, and rejects stale revisions rather than silently overwriting another writer.

Each artifact has a closed kind and an extension-generated filename under the iteration directory; titles, model output and supplied text never choose output paths. The kinds cover stage summaries, spec revisions with stable item IDs, batch plans, acceptance verdicts keyed by spec item ID with actual check records, manual trials (`pending`, `tried`, `problem`, `deferred`), and corrections/impact. Artifacts are immutable; edits are detected instead of overwritten. State publication flushes files and uses an atomic, no-clobber hard link for each immutable journal record; `state.json` is a safely replaced projection, with directory flushes where supported. A journal record is the commit boundary: recovery validates all referenced artifact envelopes and batch metadata **before** repairing an older/missing projection or writing its acknowledgement, and never replays work. Unsupported or invalid referenced evidence leaves the old projection bytes/inode and acknowledgement state untouched. A live cross-process claim fails clearly; a dead process's claim is recovered with a token-specific recovery claim. Manual edits to state or artifacts block further writes and remain byte-identical. Preserve retained versions when recovering a crash or manual edit.

Batch membership is recorded in store-owned `batchManifests`, copied from hash-checked plan artifacts, and progress in plan-bound `batchResolutions`. A consumed batch pass and its resolved manual trial become accepted progress only through a human-confirmed transition. `/project next` presents the batch summary and proposes the **next unresolved batch** for fresh implementation approval, with the exact spec/plan/batch/mode/model context. Confirming it leaves implementation idle; it does not start an executor, and it never carries the previous batch's changes pointer into the new work. A cancelled or stale dialog records no batch resolution or launch authorization.

**Overall acceptance is not a single-batch verdict.** Completion is proposed only after every batch of the pinned plan has a confirmed passing resolution or an explicit human skip. If any batch was skipped, overall completion is labelled **skipped — not a pass**, never “Accepted.” Failing, blocked, interrupted, merely published, or manual-trial-pending verdicts do not resolve a batch; earlier plan/spec revisions cannot satisfy a new plan. Legacy draft completion is interpreted only from verified consumed evidence and human receipts, never by inventing outcomes for remaining batches; historical bytes are not rewritten.

Corrections use **qualified `acceptedBatches` references**, not bare batch labels. Each reference identifies the owning spec artifact/revision/hash, plan artifact/hash, batch ID, accepted-resolution human receipt, and consumed review attempt. Both publication and correction consumption require an actual confirmed, accepted `batchResolution` with matching passing evidence and any required resolved trial. Published-only, interrupted, unconfirmed, pending-trial, skipped, and same-label/different-plan results do not qualify. A correction targeting a revised spec may reference a genuinely accepted batch of an older plan; that older owner's identity remains explicit. Legacy unqualified claims are not silently promoted into accepted evidence.

Each acceptance start captures a fresh **stage-attempt ID, review ordinal and code-snapshot hash**. Verdicts and manual-trial artifacts bind all three, along with the exact spec and batch plan, at both publication and consumption. A verdict saved for an interrupted attempt remains readable history; a continuation needs a new attempt and new verdict, even when the code snapshot is unchanged. Merely copying a batch label or increasing a numeric attempt field cannot authorize stale evidence.

Skips retain your choice and never fabricate output: a skipped prototype has no chosen variant, and skipped acceptance is **not passed**. Acceptance failure retains failing spec item IDs and proposes a human-approved return to implementation; it never starts a hidden retry loop. An automated UI pass is **batch accepted, manual trial pending** until you record that you tried it or explicitly deferred it; deferred never means tried, and the batch cannot advance or complete while the trial is unresolved. A human-confirmed **problem** on the active attempt proposes a separate, human-confirmed repair back to implementation for that same pinned spec/plan/batch. The automated verdict remains unchanged, and the manual finding/receipt remain history. The repair needs fresh implementation, acceptance, and trial evidence before that batch can be accepted; simply changing the old problem to tried/deferred is not a repair. Pending transitions and unresolved revisits take precedence over trial dialogs. Interrupting or leaving a review retires its live trial pointer while preserving attempt-bound trial artifacts as history; explicit continuation never resurrects an interrupted attempt's trial. Trial recording is offered only for the matching eligible active review.

Revisiting design/prototype during implementation or acceptance interrupts the running attempt and retains its changes pointer, or queues the revisit until a safe batch boundary if you choose to wait. Pending revisit requests are separate from returned/cancelled revisit history and correction obligations. “Continue current stage” explicitly cancels the outstanding request as well as its proposal; it does not silently resume interrupted work or erase duties from already-returned visits. An unentered cancelled request requires no invented correction; explicit continuation can resume against the unchanged approved decisions. A restart between summary publication and proposal publication reuses the saved summary to reconstruct the pending revisit. Returning and advancing again permits another revisit without losing earlier receipts or unresolved obligations. Accepted **and skipped** acceptance leave the iteration open: a confirmed revisit clears the current completion designation while preserving historical verdicts/skips. Existing changes and earlier artifacts remain; there is no Git reset, transcript rewind or prototype promotion. Correction artifacts link superseded → new decision IDs, affected spec item IDs and changed files, so later execution can approve a correction batch rather than restart from scratch. Every outstanding executable-work correction must be mapped against a revised spec before execution can resume. Execution and automatic impact generation arrive in later steps; this step supplies their state and evidence model only.

`/project next` does not invent a completed summary. If no stage output is ready it explains the missing gate. You can continue design or explicitly skip it. Saved design can be finalized into a summary with its confirmed decision IDs, then proposed for the next stage. “Continue current stage” cancels a pending proposal and invalidates the prepared design summary. A stranded design attempt after a crash requires explicit interruption/continuation confirmation; the interrupted record is retained. Design writers share the iteration claim, invalidate captured state revisions before publication, and reject late questions after a revision or stage change. During a stage change the local design runtime is stopped/drained before confirmation is committed. Skipping into implementation/acceptance still requires the exact saved spec/batch/mode/model or existing-change context; this step does not invent those approvals. At a later-stage execution boundary the command clearly reports **not available yet**, without spawning agents, running commands or opening a prototype.

Storage failures expose structured diagnostic reasons. Commands and panel errors use the effective batch-one language policy (`en`/`zh`/`ja`), including stale revision numbers and recovery actions. A freshly validated marker supplies the language even if iteration loading fails immediately, including after resume without a panel refresh. Unsupported numeric schema versions in markers, journals, state and artifact envelopes report encountered/supported versions and compatibility instructions, separately from malformed data or a broken hash chain; no such error is repaired by deleting or rewriting evidence. Artifact compatibility tests use coherent hashes and projection receipts, and verify byte preservation.

## Design conversation

There is **one owned conversation per project ID and iteration**. Reopening is inert: it does not call a model or replay an unfinished question. Enter a message to continue. A new iteration uses `design.md` and `decisions.md`, never the previous iteration's transcript. Iteration advancement is not implemented; new projects start at iteration 1.

The native transcript and composer are shared visually, not operationally. Main work keeps running. **F6** returns to main; **Esc** also returns when the design conversation is idle and its composer is empty. While design is working, Esc/Ctrl+C stops design only. Drafts, history and question dialogs are handled by the host. Slash commands must be run after returning to main. The host focus indicator shows main status/pending attention.

Design history survives main `/clear` and `/resume`. Closing focus does not stop/release it. A second process holding the design conversation gets an **in use** error. Host unload/exit stops and releases runtime resources without deleting saved history. Unsupported hosts explain the missing capability; there is no ephemeral-session fallback.

### Tools and questions

Research operations are restricted to `read`, `grep`, `glob`, `web_search`, `web_fetch`. `ask_user` and the fixed extension tools `record_decision`, `record_suggestion`, `save_research_note`, `update_design_doc` and `project_research` provide the control plane and constrained output writes. No arbitrary `write`, `edit`, shell, `agent`, worktree, workflow or swarm tools are admitted. Web availability still depends on the host; the extension does not make its own network requests.

The model is instructed to lead with multiple-choice questions: recommended option first, each description explaining trade-offs. Previews are text, code, tables or ASCII only. Questions appear as normal human dialogs in the focused transcript. The extension never asks the main model to answer on your behalf.

`project_research` starts fresh-context, read-only children through the owned conversation's `createGroup`. Their tool ceiling cannot widen, their cwd is fixed, and they cannot ask or confirm decisions. Only the extension's constrained note writer saves research output.

### Evidence and recovery

Only validated human dialog answers become decisions. A model-authored recommendation remains in `suggestions.md`. Each decision retains an ID, actual confirmation date, full question/options/trade-offs, exact selected labels or free-text alternative answer, language, and an ask-record reference. “Other” is an alternative choice, **not** a rationale. No reason is inferred from it or from a model recommendation; a rationale requires a separately requested human explanation. Cancelled, unavailable, aborted or invalid responses do not create decisions.

Before returning an answer to the model, the extension durably writes structured evidence under `.amira/project/` (JSON lines, with file flush). Cancellation is checked after entering the per-project queue and immediately before publication. The final identity check, rename, directory flush where supported, and cleanup form a short non-yielding commit section. The owner receipt **does not wait on Markdown I/O after that commit**: a later ordinary event-loop Stop cannot overtake its acknowledgment. Cancellation processed before publication produces no decision; successful publication is the extension's commit boundary. `SessionData.append` is not used as a durability acknowledgment.

Markdown is a derived projection, scheduled separately after owner-answer acknowledgment and retried on the next design open. Projection failures/conflicts are reported separately, never turned into a false declined/no-decision receipt. A process crash between evidence publication and host acknowledgment cannot be a filesystem/host transaction; the durable human evidence remains authoritative and recovery does not infer a new answer from prose. Superseding requires a new human confirmation and preserves the old record (`supersedes D3`, with the reverse link in the ledger).

Generation metadata tracks `decisions.md`'s hash. If you edit it by hand—even during generation—the extension preserves the actual edited inode and generates a sibling `decisions.generated.md`. Publication uses retained versions plus no-clobber hardlinks, not a stale hash check followed by unconditional replacement. Design/suggestion tools likewise report conflicts and their actual sibling output paths instead of claiming the named file was updated. Hardlink support is required; unsupported filesystems fail before moving the original.

Hidden `.preserved` versions intentionally remain: an editor holding an old writable descriptor may still save into one. Do not remove them while editors may hold those files. There is a brief pathname gap between retaining an old file and publishing its replacement; after a crash, a retained version may need restoring, especially for human-only annotations. The evidence can always regenerate confirmed decisions, but cannot reconstruct handwritten annotations that were never evidence. Do not manually edit evidence or generation metadata.

Legacy evidence from the rejected writer remains byte-for-byte intact and its original hash chain is verified separately. Corrected semantic views, Markdown and new-iteration model seeds no longer treat its automatic `Other` copy as a rationale; they mark that legacy explanation as unverified. New projection records explicitly distinguish this corrected interpretation from historical bytes.

## Language

Precedence: **project `settings.language` > extension Document language > user's conversation language**. Select the effective source before validating it; an invalid lower-priority setting cannot block a valid project override. An explicit project value of `conversation` follows the human conversation, not the extension default. Edit the marker's project setting when you want a project-specific override. Language changes affect **new content only**, never retranslate past evidence or documents automatically.

Already-open design runtimes follow these changes without reopening: extension-setting callbacks update their current policy, and every model continuation re-reads the captured project's marker settings. New document tools and new questions refresh and capture their effective language too; no filesystem watcher or automatic model turn is started. A question already shown to you retains its presented language through the answer, evidence and receipt. Subsequent work uses the new effective setting. The saved conversation spec/history and existing documents are not rewritten.

Generated text supports **English (`en`), Chinese (`zh`, including `zh-CN`) and Japanese (`ja`)**, including regional tags in these language families. Any other valid tag falls back to English, with an explicit notice once per unsupported tag per extension run. The requested tag remains in project settings; new evidence records the effective output language. Invalid tags are not silently accepted.

Chinese/English/Japanese human turns can be inferred conservatively (Japanese kana is checked before Chinese Han characters); if there is no reliable signal, creation/design asks for a language tag. Terminal locale and model/agent messages are not authoritative. Model-facing instructions remain English with a one-paragraph summary in the effective user language. Ledger scaffolding, suggestion headings, status/panel summaries and the design introduction use the same localization policy.

## Development and offline verification

```sh
cd extensions/project
bun install
bun run link-amira ../../../Amira
bun run typecheck
bun run lint
bun test
```

`link-amira` links **only `@amira/*`** packages from the checkout. The relative path above assumes the Amira and extension-repository checkouts are siblings; replace it with your checkout location. Dependencies are extension-local. The test preload creates temporary HOME/USERPROFILE/AMIRA_HOME/cwd, removes live flags/credentials, and blocks fetch. Tests use mock dialects and temporary project directories; no real home, model API or GUI is required.

Host-source tests discover the checkout in this order:

1. `AMIRA_SOURCE`, when set, selects the checkout explicitly. An invalid explicit location does not fall back to another checkout.
2. Otherwise, the real filesystem targets of linked `@amira/*` packages identify the checkout.

No machine-specific checkout path is assumed. If source is unavailable, a required host export is missing, or a host module cannot be imported, affected cases are registered as clear skips with a reason and one shared source notice per process. Extension-only tests still run. Failures inside a loaded test are test failures, not skips. Install and link the development packages before running typecheck or tests; source discovery does not replace dependencies.

To select a prepared checkout explicitly from `extensions/project`, use an absolute resolved path so the isolated test cwd does not affect it:

```sh
# POSIX
AMIRA_SOURCE="$(cd ../../../Amira && pwd)" bun test
```

```powershell
# PowerShell
$env:AMIRA_SOURCE = (Resolve-Path ../../../Amira).Path
bun test
Remove-Item Env:AMIRA_SOURCE
```

`test/frontend.test.ts`, `test/frontend-batch.test.ts`, `test/frontend-trial.test.ts`, and `test/frontend-manual-repair.test.ts` provide checked-in **inline and fullscreen** acceptance coverage. They import the host's `packages/tui/test/app-harness.ts` helpers and drive real `runInteractive`, `FakeTerminal`/`VirtualScreen`, `ExtensionHost`, durable sessions and `OwnedConversationManager`. No UI dialogs or panel renderer are substituted. Tests send terminal keys and assert fresh command output, actual screen captures and durable state for cancellation, stale answers (including Chinese/Japanese), restart at revisit request/summary/proposal boundaries, repeated visits, accepted/skipped completion revisits, focused slash-command guards, B1 → confirmed B2 progression, pending-trial interruption/continuation, and human problem → approved same-batch repair → fresh review/trial. Run them with `bun test test/frontend.test.ts test/frontend-batch.test.ts test/frontend-trial.test.ts test/frontend-manual-repair.test.ts`; the same isolated-home preload applies.

Optional terminal walkthroughs use `bun <amira-checkout>/scripts/ui-walk/walk.ts start --extension <extension-checkout>/extensions/project` with the harness's isolated home, offline scripted provider and headless PTY. Screenshots are verification artifacts, not a requirement to install the extension.
