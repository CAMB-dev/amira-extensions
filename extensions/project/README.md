# Project (experimental)

Project discovery, a persistent design conversation, and an auditable record of **human** decisions. This is batch one: prototypes, implementation/spec execution, acceptance, shipping, budgets, dashboard integration and archive workflows are **coming later**.

Requires Amira extension API **0.1.52** (owned conversations arrived in 0.1.51; native conversation focus in 0.1.52). No workflow, swarm, btw or dashboard dependency.

## Commands

Run commands from the **main** conversation:

| Command | Action |
| --- | --- |
| `/project` or `/project list` | Choose from previously opened projects plus the nearest discovered project. No disk scanning. |
| `/project new [name] [--root <directory>] [--language <tag>] [--commit-documents]` | Create and attach a project. Without a name, ask for one. Default directory: current working directory. Quote names/directories containing spaces. |
| `/project switch [name, id, or directory]` | Attach a known/discovered project, or open an explicit directory. Without an argument, show the picker. Duplicate names require an ID or directory. |
| `/project status` | Show attached directory, iteration, stage and next step. |
| `/project design` | Open this project's saved design conversation for the current iteration. |
| `/project help` | Show command help and the batch boundary. |

Example: `/project new "Local planner" --root "D:\work\planner" --language en`.

**Attaching is metadata-only:** the main conversation's working directory does not change. The design conversation and research children use the selected project directory. One project is attached per main session. Attachments follow that session's branch (including resume/fork/rewind); the latest snapshot wins. An attachment receipt is persisted even before the first model prompt. Memory-only hosts cannot promise next-run attachment persistence.

The panel above the input shows name, iteration, design stage and a design hint. Before opening design it says “Open design conversation.” Once a design runtime is available it uses a neutral continuation/F6 return hint, not a command to open the conversation again. Host panels receive the main session ID even during native design focus, so the extension does not claim to infer focus from that ID. The host's native focus indicator identifies the actual composer target. The normal panel-collapse control leaves the summary line visible. Missing/invalid status appears before long paths in picker labels; the extension never silently substitutes a nearby project.

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
      iterations/1/           # iteration output location; later stages not implemented
      decisions.evidence.jsonl # authoritative human-answer records (created on first answer)
      decisions.manifest.json  # acknowledged generated Markdown hash
      decisions.generated.md  # conflict-only projection; never overwrites hand edits
```

Creation preserves existing `.gitignore` content and appends `.amira/project/` unless `--commit-documents` is selected. The marker is not ignored. Changing `settings.commitDocuments` later does not remove an existing ignore rule; review `.gitignore` yourself if you decide to commit the documents.

The extension writes only its fixed documents, evidence and generated research-note filenames. Canonical root, ancestor and output-directory identities are pinned when a project is captured, then checked again before writes and publication. Replacing a root or captured ancestor with a junction is rejected even if the redirected tree contains the same project marker. Traversal and symlink/junction escapes are rejected. External output directories are not supported in this batch. These are application safeguards, **not an OS sandbox**: portable Node APIs cannot eliminate the last kernel-call race against a hostile process continuously swapping directories. Allowed read tools may read outside the project according to host permissions.

## Design conversation

There is **one owned conversation per project ID and iteration**. Reopening is inert: it does not call a model or replay an unfinished question. Enter a message to continue. A new iteration uses `design.md` and `decisions.md`, never the previous iteration's transcript. Iteration advancement is not implemented; batch one starts at iteration 1.

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
bun run link-amira D:/dev/Amira
bun run typecheck
bun run lint
bun test
```

`link-amira` links **only `@amira/*`** packages from the checkout. Dependencies are extension-local. The test preload creates temporary HOME/USERPROFILE/AMIRA_HOME/cwd, removes live flags/credentials, and blocks fetch. Tests use mock dialects and temporary project directories; no real home, model API or GUI is required.

Terminal walkthroughs use `D:/dev/Amira/scripts/ui-walk/walk.ts start --extension <absolute-path>` with the harness's isolated home, offline scripted provider and headless PTY. Screenshots are verification artifacts, not a requirement to install the extension.
