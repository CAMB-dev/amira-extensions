# Dashboard (experimental)

The first default dashboard extension for Amira (D103/D104). It lives in **amira-extensions**, not Amira core. Version 0.1.0 targets API **0.1.23** and its experimental declarative widgets. We will iterate on the interface and source contract.

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

Schematic wide view (180×52; actual styling comes from your terminal theme):

```text
amira · workspace  │ Agents │ 1/2 running │ $0.042                         ? help · b back · q quit
──────────────────────────────────────── agents ─────────────────────────────────────────────────
            ◉ Agents                                                                          ▾
10:12:40  ●  ├─◉ Build ×2 · 1 running                                              spawn-group  ▾
            │ ├─● API worker                                                          running
            │ │ ╭ ● API worker [TypeScript] ─────────────────────────────────────────────────╮
            │ │ │ Define the event contract                                                   │
            │ │ │ ━━━━━━━━━━━       75%                                                        │
            │ │ │ 2 files reported changed · $0.030                                            │
            │ │ │ src/events.ts                                                               │
            │ │ │ o Open diff · p Pause · r Request changes · a ⋮ Actions                      │
            │ │ ╰────────────────────────────────────────────────────────────────────────────╯
            │ └─✓ Reviewer                                                           done
            └─────────────────────────────────────────────────────────────────────────────────
╭ Details · API worker ────────────────────────────────────────────────────────────────────────╮
│ Summary │ Diff │ Logs │ Actions                                                              │
│ ● API worker · running · $0.030                                                              │
│ Define the event contract                                                                   │
╰─────────────────────────────────────────────────────────────────────────────────────────────╯
Enter opens an agent · e expands all · Tab moves focus · 1–4 switches tabs
```

An adapter may supply a real progress fraction (as in this schematic). The built-in sources show **Progress unknown**, not a guessed percentage, until successful completion. A language chip appears only when reported file extensions identify a single known language.

At 80×24, only the selected agent gets a card, file previews are shortened, and the detail panel is smaller. The host scrolls the tree and detail body independently. Open the agent page for more room:

```text
amira · workspace │ Agents │ 1/2 running │ cost unknown                  ? help
────────────────────────── API worker · Live agents ─────────────────────────
╭ Details · API worker ──────────────────────────────────────────────────────╮
│ Summary │ Diff │ Logs │ Actions                                           │
│ ● API worker · running · cost unknown                                     │
│ Define the event contract                                                │
│ ...                                                                      │
╰──────────────────────────────────────────────────────────────────────────╯
←→ tabs · b back to dashboard · Esc/q closes dashboard
```

Replay adds a **Stats** tab: first-token wait, streaming, unclassified model time, tool interval union, approval wait and idle; a per-tool count/total/average/maximum/outcome table; failures; and cost per agent. These time measures can overlap and **must not be summed into wall time**. Each trace is summarized separately with `summarizeTrace`; parent/child costs are never recursively added twice. Missing cost is shown as unknown, not zero.

## Keys and actions

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a timeline row or action; scroll a focused text body |
| ← / → | Expand/collapse the focused tree; switch focused tabs (or page tabs from a text body) |
| Enter | Open a selected agent page or activate an action |
| e | Expand all phases, groups and agent cards |
| Tab / Shift+Tab | Move focus between public widgets |
| 1–4 | Summary / Diff / Logs / Actions |
| 5 | Stats, when the selected agent has trace statistics |
| o | Open the selected agent's Diff tab |
| p | Pause/resume, if the source supports it |
| r | Prompt for requested changes; send only when the source supports messaging |
| a | Open and focus the Actions table (the card's ⋮) |
| x | Stop the selected agent, after confirmation |
| b | Return from an agent page to the timeline |
| ? | Show keyboard help |
| Esc / q / Ctrl+C | Close the dashboard (host-owned) |

Card action labels are keyboard hints, not pretend clickable buttons: tree detail widgets are display-only in this API. From the timeline, **p/r/x focus a single named action; press Enter to continue**. On an agent page they act directly on that page's fixed target. The Actions table provides an Enter-activated path for every action. Its row keys include the target agent, so host selection repair or same-kind view replacement cannot redirect an action to an old selection. `UiControl` has no state getter; the handler deliberately does not guess the host's current selection. Status always includes a word or mark, not color alone.

### Current API limits

- **Esc cannot go back one page.** `ViewDefinition` reserves it for closing the entire view, and `ViewControl` has no navigation stack or close interception. This version uses **b** for back rather than claiming otherwise.
- `SessionControl.stopSubagent(id)` is available. **Pause/resume and messaging arbitrary existing sub-agents are not.** `ChildSession.send` exists for extensions holding the child handle, but the dashboard cannot retrieve that handle. It never invents a session method or sends a request to the main agent instead. Request changes opens the prompt and reports **Not sent** when unsupported.
- Authoritative `writtenPaths` identify files, not their before/after content. Diff shows supplied diff lines when an adapter has them; otherwise it lists reported paths with **No diff available**. It does not attribute the entire workspace's git diff to an agent.
- Traces contain completed intervals and bounded tool previews, not unfinished work or full tool payloads. An empty trace is not evidence of zero work or zero cost.
- A live source observes events while loaded and also reads session listings/messages. Files changed before its event subscription may not be known; trace replay can recover persisted `writtenPaths`.
- API `UiContext` exposes width, **not height**, and `@amira/api` exports no terminal widget renderer. Tests snapshot public semantic widget trees for the 180×52 and 80×24 target viewports; these are **not terminal-cell raster snapshots**. Actual terminal rendering and host keyboard dispatch need a TUI smoke test. The extension does not import private TUI code to fake that verification.

## Source service

The extension provides `dashboard.sources` via `provideService`. Workflow and swarm adapters are deliberately deferred; neither existing extension is changed here.

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

- `DashboardSnapshot`: `{ workspace, phases, note? }`.
- A phase: `{ id, name, groups }`. A group: `{ id, name, ref?, agents }`.
- An agent: `{ id, name, task, status, files, actions, startedAt?, durationMs?, cost?, language?, progress? }`.
- Status: `queued | running | idle | paused | done | failed | stopped`.
- A file: `{ path, diff?: ViewLine[] }`; a path alone must not imply diff content.
- Details: `{ summary: ViewLine[], logs: ViewLine[], stats?: TraceSummary }`.
- Cost is USD for that agent's **own** usage, not its descendants. Omit unknown cost.
- Progress is a known 0–1 fraction; omit it when unknown. Do not estimate completion from a count of tools.
- Agent IDs are unique across a source; phase IDs across the snapshot; group IDs within their phase. Keep them stable across redraws. Sources `agents` and `trace` are reserved. Custom IDs start with a letter and contain letters, numbers, underscores, dots or hyphens. Duplicate registration throws.
- Reads are synchronous, side-effect-free and fast: cache asynchronous work outside rendering. Keep the snapshot and its details coherent. Bound live logs. Publish changes through `subscribe`; the dashboard requests a host redraw. No subscriptions are created by `ui()`.
- The `actions` list advertises actual capabilities; `act` must check the target still exists and is authorized at invocation time. Return a short English result, or throw an error the view can show. Never perform work during `snapshot()` or `details()`.
- The registry subscribes once per registration. The returned disposer is idempotent and unsubscribes; an old disposer cannot remove a replacement. A view for an unregistered source becomes unavailable instead of retaining its actions. Adapters own and must release their other resources, including on reload. Re-register against a newly loaded dashboard service after dashboard reload.
- This experimental service name is a contract: compatible additions are optional; a breaking shape change should use a new service name rather than silently changing this one.

## Development

From this folder, with Bun and a local Amira checkout whose dependencies are installed:

```sh
bun install
bun scripts/link-amira.ts D:/dev/Amira
bun test
bun run typecheck
bunx biome check .
```

The helper links only `@amira/api` and its transitive `@amira/ai` dependency. Extension runtime imports remain API-only; the linking script uses Node filesystem utilities, and tests use `bun:test`. Tests use fake sessions and event buses, no models, network requests, process killing or changes to core. Snapshot updates: `bun test --update-snapshots` after inspecting intentional widget changes.

License: Apache-2.0.
