# Dashboard (experimental)

The default dashboard extension for Amira (D103/D104/D105). It lives in **amira-extensions**, not Amira core. Version 0.2.2 targets API **0.1.24**, using host-owned pages, view lifecycle hooks and sub-agent controls. The declarative widgets and source contract remain experimental.

Runtime code imports only `@amira/api` and local modules. The host owns terminal rendering, themes, clipping, focus and scrolling. Nothing in this extension reads private core state or runs shell commands to infer an agent's changes.

## Usage

Install this extension through your Amira extension configuration, then:

```text
/dashboard                 Live sub-agents (always available)
/dashboard agents          The same live source
/dashboard trace           Snapshot of this session's and its descendants' traces
/dashboard <source-id>     A source registered by another extension
```

The command offers source-ID completion. Trace replay reads completed records once when opened; reopen it to refresh. It does not switch sessions or accept arbitrary trace paths. A frontend without full-screen views gets a note instead.

### Screenshots as text

Real output of the dashboard rendered through Amira's TUI `ExtensionViewer` with fake sub-agents
(`test/tui-render.test.ts`), plain text without colors, **on the first frame without input**.
Phases and cards start expanded, with the first active phase’s agent selected. Each phase has one shared card frame, without duplicate group or agent tree rows. Wide view, 180×52:

<!-- render:180x52 -->

```text
 amira  │  workspace: acme/checkout  │  phase: Implementation  │  running: 1/3  │  cost: unknown                                                             ? shortcuts  │  q quit
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
» 09:00:30  ● ◉ Implementation… Validate payment amounts and add regression coverage for partial refunds.   ▏running 90s▕                                             checkout-v2  ▾
              │  ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
❯             ├──▶ ● Payment val…  Validate payment amou…  [TypeScript]    ━━━━━━━━──────  60%                      2 files changed ▸  │  Open diff   Pause   Request changes   ⋮ │
              │  │   Amount validation is implemented; regression tests are in progress.                                                                                          │
              │  │                                                                                                                                                                │
              │  │   Changed files                                                                                                                                                │
              │  │   src/payments.ts                                                                                                                                              │
              │  │   test/payments.test.ts                                                                                                                                        │
              │  │ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
              ├──▶ ‖ Receipt tem…  Check the receipt tem…                  ──────────────  —                                          1 file changed ▸  │  Open diff   Resume   ⋮ │
              │  │   Waiting for approval.                                                                                                                                        │
              │  │                                                                                                                                                                │
              │  │   Changed files                                                                                                                                                │
              │  │   templates/receipt.html                                                                                                                                       │
              │  │                                                                                                                                                                │
              │  │ 2 agents · 1 running                                                                            e expand all · o diff · p pause/resume · r changes · a actions │
              │  ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
              │ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  09:00:00  ✓ ○ Review          1 agent · 45s                                                                                                                              review  ▾
              │  ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
              └──▶ ✓ Refund audit  Review authorization …                  ━━━━━━━━━━━━━━  100%                                                      no changes  │  Open diff   ⋮ │
              │  │   No authorization issues found.                                                                                                                               │
              │  │   done in 45s                                                                                                                                                  │
              │  │                                                                                                                                                                │
              │  │ 1 agent · 0 running                                                                             e expand all · o diff · p pause/resume · r changes · a actions │
              │  ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
              │ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
              │
              │
              │
              │
──────────────────────────────────────────────────────────────────────────────────────── ≡ ─────────────────────────────────────────────────────────────────────────────────────────
  [Summary]  Diff  Logs  Actions  Stats                                           Payment validation  Validate payment amounts and add regression coverage for partial refunds.   ✕
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Agent    Payment validation    │   What this agent is doing                                                                    │   Changed files  2 files
  Task     Validate payment amou…│   Amount validation is implemented; regression tests are in progress.                         │   src/payments.ts
  Kind     TypeScript            │                                                                                               │   test/payments.test.ts
  Status   running               │                                                                                               │
  Runtime  90s                   │                                                                                               │
  Started  09:00:30              │                                                                                               │
  Tokens   0.0k · $0.1250        │                                                                                               │
                                 │                                                                                               │
                                 │                                                                                               │
                                 │                                                                                               │
                                 │                                                                                               │
 o open diff   p pause/resume   r request changes   a actions   x stop                                                                          1–4 tabs · 5 stats (when available)
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Ask Amira or enter a command after closing this view…                                                                                      Hint only · close this view to send │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
Tab focus · arrows navigate · Enter open/send · PgUp PgDn scroll · Esc close
```

<!-- /render:180x52 -->

An adapter may supply a real progress fraction (as for "Payment validation" above). The built-in sources show a dim empty bar and **—**, not a guessed percentage, until successful completion. A language chip appears only when reported file extensions identify a single known language. Collapse phase boxes or fold card contents with **←**; press **e** to restore expand-all mode, including workers that arrive later. A folded last card keeps the frame’s count and expand hint in its bottom border.

At 80×24 only the selected phase’s box is shown, with shorter card fields and a 6-row details panel. Wide details use 9–15 rows and a three-column Summary; narrow Summary stacks the same information in a scrollable body. Without an agent selected, details shrink to a handle and one placeholder line. The timeline fills the remaining space, continuing its rail rather than adding blank gap rows. The host scrolls the timeline and details independently. Open an agent page (Enter) for more room:

<!-- render:80x24 -->

```text
 amira  │  workspace: acme/checkout                              ? help · q quit
phase: Implementation  │  running: 1/3  │  cost: unknown
────────────────────────────────────────────────────────────────────────────────
» 09:00:30  ● ◉ Implementatio… Validate payment amounts and add regression co… ▾
              │  ╭────────────────────────────────────────────────────────────╮
❯             ├──▶ ● Payment v… ━━━━──  60%                            o diff │
              │  │   Amount validation is implemented; regression tests are … │
              │  │   Changed files                                            │
              │  │   src/payments.ts                                          │
              │  │   +1 more · o open diff                                    │
              │  │ ────────────────────────────────────────────────────────── │
              ├──▶ ‖ Receipt t… ──────  —                              o diff │
              │  │   Waiting for approval.                                    │
              │  │   Changed files                                            │
────────────────────────────────────── ≡ ───────────────────────────────────────
  [Summary]  Diff  Logs  Actions  Stats
────────────────────────────────────────────────────────────────────────────────
  Payment validation · running · 90s
  Validate payment amounts and add regression coverage for partial refunds.
 1–4 tabs · o diff · a actions · ? shortcuts
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask Amira after closing this view                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
Tab focus · arrows navigate · Enter open/send · PgUp PgDn scroll · Esc close
```

<!-- /render:80x24 -->

Replay adds a **Stats** tab: first-token wait, streaming, unclassified model time, tool interval union, approval wait and idle; a per-tool count/total/average/maximum/outcome table; failures; and cost per agent. These time measures can overlap and **must not be summed into wall time**. Each trace is summarized separately with `summarizeTrace`; parent/child costs are never recursively added twice. Missing cost is shown as unknown, not zero.

## Keys and actions

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a timeline row or action; scroll a focused text body |
| ← / → | Expand/collapse the focused tree; switch focused tabs (or page tabs from a text body) |
| Enter | Open a selected agent page or activate an action |
| e | Expand all phases and card contents |
| Tab / Shift+Tab | Move focus between public widgets |
| 1–4 | Summary / Diff / Logs / Actions |
| 5 | Stats, when the selected agent has trace statistics |
| o | Open the selected agent's Diff tab |
| p | Pause/resume, if the source supports it |
| r | Prompt for requested changes; send only when the source supports messaging |
| a | Open and focus the Actions table (the card's ⋮) |
| x | Stop the selected agent, after confirmation |
| ? | Show keyboard help |
| Esc | Cancel a prompt first; otherwise return from an agent page, or close at the timeline |
| q / Ctrl+C | Close the whole dashboard; q types text inside a prompt, Ctrl+C always closes |

The framed bottom bar is a **hint, not an input**: close the dashboard to ask Amira or enter a command. A focused input would consume navigation shortcuts, and the source contract has no general chat submission action. The host’s own navigation key bar remains the only in-view list of arrows/Tab/Enter/Esc.

Card action labels are keyboard hints, not pretend clickable buttons: tree detail widgets are display-only in this API. From the timeline, **p/r/x focus a single named action; press Enter to continue**. On an agent page they act directly on that page's fixed target. The Actions table provides an Enter-activated path for every action. Its row keys include the target agent, so host selection repair or same-kind view replacement cannot redirect an action to an old selection. `UiControl` has no state getter; the handler deliberately does not guess the host's current selection. Status always includes a word or mark, not color alone.

### Behavior and data boundaries

- Agent pages use the host page stack. **Esc** restores the timeline's selection, expansion, tabs, focus and scroll position; it closes only at the root. The old **b** workaround is removed.
- Live running agents offer **Pause**; paused agents offer **Resume**. Pausing holds before the next model call without aborting current work or freeing an admission slot. **Request changes** prompts for a user-authored message and sends it with `messageSubagent`; queued messages wait for admission, and idle persistent children start another turn. Notes report accepted requests or agents that are no longer running. Accepted delivery does not mean the model has read the message yet.
- Live event subscriptions and source update subscriptions exist only while the dashboard is open, and close releases them. Session listings and messages remain authoritative; live files/logs cover only observed activity. Files changed before opening may not be known; trace replay can recover persisted `writtenPaths`.
- Authoritative `writtenPaths` identify files, not their before/after content. Diff shows supplied diff lines when an adapter has them; otherwise it lists reported paths with **No diff available**. It does not attribute the entire workspace's git diff to an agent.
- Traces contain completed intervals and bounded tool previews, not unfinished work or full tool payloads. An empty trace is not evidence of zero work or zero cost.
- Semantic snapshots cover widget contracts. `test/tui-render.test.ts` also renders the actual TUI at 180×52 and 80×24, including first-frame expansion and Esc navigation (skipped without a linked checkout). This is not a real-terminal test; runtime code never imports the TUI.

## Source interface

The extension provides `dashboard.sources` via `provideService`. Workflow and swarm register optional adapters: `/dashboard workflow` shows agent calls, and `/dashboard swarm` shows members with dedicated **Board** and **Messages** tabs.

Look up the service when registering (it may be absent or reloaded), and retain the disposer:

```ts
const service = api.useService("dashboard.sources")
const unregister = service?.register(source)
// On adapter shutdown/unload, call unregister?.()
```

The exported contract is in [`src/source.ts`](src/source.ts) (also the package's `./source` type entry). Extensions that avoid importing another extension can mirror the structural contract in their own type declarations. Its declaration merging types `AmiraServices["dashboard.sources"]` when included:

```ts
interface DashboardSources {
  register(source: DashboardSource): () => void
}

interface DashboardSource {
  id: string
  label: string
  snapshot(): DashboardSnapshot
  details(agentId: string): DashboardDetails | undefined
  subscribe?(changed: () => void): () => void
  act?(
    agentId: string,
    action: "pause" | "resume" | "stop" | "request-changes",
    text?: string,
  ): string | Promise<string>
}
```

### Data contract

- `DashboardSnapshot`: `{ workspace, phases, note?, warning? }`. Usage caveats (`note`) stay in Stats; an empty source uses its note as an explanation. Operational warnings (`warning`) appear in Summary’s Notes, including at narrow widths.
- A phase: `{ id, name, groups }`. A group: `{ id, name, agents }`. Both may report `ref`, `status`, `startedAt`, `durationMs`, `description`, and `stepCount`. The timeline flattens a phase’s groups into one card box. Missing phase metadata falls back to reported group/agent data; unknown start times remain `--:--:--`, and step counts are never inferred from tool calls.
- An agent: `{ id, name, task, status, files, actions, sessionId?, startedAt?, durationMs?, cost?, language?, progress? }`.
- `sessionId?: string` is the actual child session ID, not the dashboard agent ID. When supplied, **Actions → Open transcript / Open trace** opens a host-owned page using `SessionControl.subagentMessages(sessionId)` or `SessionControl.trace(sessionId)`. Transcript shows recorded messages; trace opens the same **Stats** view used by replay, plus recorded logs. These reads remain host-authorized; missing or unrelated sessions show unavailable data. Esc returns to the agent page with its state intact. Sources without `sessionId` keep their existing actions.
- Status: `queued | running | idle | paused | done | failed | stopped`.
- A file: `{ path, diff?: ViewLine[], added?: number, removed?: number }`; a path alone must not imply diff content or line counts.
- Details: `{ summary: ViewLine[], logs: ViewLine[], stats?: TraceSummary, tabs?: DashboardTab[], notes?: ViewLine[], steps?: { text: string; status: "done" | "running" | "queued" }[] }`. Steps and notes are source-reported, not synthesized.
- A custom tab: `{ key: string; label: string; render(): UiNode | ViewLine[] }`. Tabs append after the built-ins; use the focused tab bar's arrows (or arrows from its text body) to reach them. Keys must be nonempty, stable and unique. `summary`, `diff`, `logs`, `actions` and `stats` are reserved; duplicate/reserved keys are ignored. `render()` follows the same synchronous, side-effect-free rules as other source reads. Line arrays become scrollable text; widget trees retain host-owned focus, selection and scroll. IDs must be unique within each tab; the dashboard namespaces them across tabs and agent pages. The contract supplies content only, not custom event handlers. Omitting `tabs` preserves the original page.
- Cost is USD for that agent's **own** usage, not its descendants. Omit unknown cost.
- Progress is a known 0–1 fraction; omit it when unknown. Do not estimate completion from a count of tools.
- Agent IDs are unique across a source; phase IDs across the snapshot; group IDs within their phase. Keep them stable across redraws. Sources `agents` and `trace` are reserved. Custom IDs start with a letter and contain letters, numbers, underscores, dots or hyphens. Duplicate registration throws.
- Reads are synchronous, side-effect-free and fast: cache asynchronous work outside rendering. Keep the snapshot and its details coherent. Bound live logs. Publish changes through `subscribe`; the dashboard requests a host redraw. No subscriptions are created by `ui()`.
- The `actions` list advertises actual capabilities; `act` must check the target still exists and is authorized at invocation time. Return a short English result, or throw an error the view can show. Never perform work during `snapshot()` or `details()`.
- Registration keeps a source discoverable without subscribing while the dashboard is closed. Opening a source subscribes to its updates; closing or switching sources releases that subscription. The registration disposer is idempotent and releases active subscriptions; an old disposer cannot remove a replacement. A view for an unregistered source becomes unavailable instead of retaining its actions. Adapters own and must release their other resources, including on reload. Re-register against a newly loaded dashboard service after dashboard reload.
- This experimental service name is a contract: compatible additions are optional; a breaking shape change should use a new service name rather than silently changing this one.

## Development

From this folder, with Bun and a local Amira checkout whose dependencies are installed:

```sh
bun install
bun scripts/link-amira.ts D:/dev/Amira
bun test
bun run typecheck
bunx --package @biomejs/biome biome check .
```

The helper links `@amira/api` and its transitive `@amira/ai` dependency, plus `@amira/tui` and `@amira/tui-kit` for the render test when the checkout has them. Extension runtime imports remain API-only; the linking script uses Node filesystem utilities, and tests use `bun:test`. Tests use fake sessions and event buses, no models, network requests, process killing or changes to core. Snapshot updates: `bun test --update-snapshots` after inspecting intentional widget changes. Regenerate the README's first-frame captures with `UPDATE_DASHBOARD_README=1 bun test test/tui-render.test.ts` (PowerShell: set `$env:UPDATE_DASHBOARD_README = "1"` before running the test).

The frozen workflow in `test/prototype-fixture.ts` maps User request / Plan / Code Agent ×3 / Integrate / Check / Complete onto the public source contract. `test/prototype-render.test.ts` compares the 180×52 timeline against the approved variant D **line by line**, with full rendered snapshots at both sizes. It uses the prototype’s collapsed-phase state for the wide comparison. Set `DASHBOARD_COMPARE=path/to/comparison.txt` when running that test to write numbered dashboard/target lines side by side. The checked-in target is copied from the approved plain-text artifact; native widget selection markers/chips and unknown timestamps intentionally differ.

License: Apache-2.0.
