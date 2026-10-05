# computer-use-uia (experimental)

Windows desktop control through the built-in .NET UI Automation client. **Off by default**,
Windows only, tree only: no screenshots, OCR, browser driver, native npm modules or shipped
compiled binaries. Requires Amira API **0.1.27** and Windows PowerShell 5.1. The helper uses
UIAutomationClient, UIAutomationTypes and the built-in UIAutomationClientsideProviders for
Win32 controls. Its small in-memory P/Invoke shim is not a shipped binary.

## Enable

Install with `amira ext install computer-use-uia`, then opt in in **`~/.amira/settings.json`**
(the user's settings, not a repository's `.amira/settings.json` or `settings.local.json`):

```json
{
  "extensions": {
    "computer-use-uia": {
      "enabled": true
    }
  }
}
```

`enabled` defaults to `false`, even after installation. Omitting `apps` permits only `testWindow`,
the bundled `helper/test-window.ps1` WinForms window owned by its launched `powershell.exe` PID.
Its script path is resolved from the installed extension, not the working directory, and it
runs with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script path>`. The fixture
has named multiline/single-line text fields, a button/status label, a checkbox and an item list.
You can add classic Win32 apps with entries such as `"editor": { "command": "C:\\Tools\\editor.exe" }`
(using JSON-escaped backslashes in settings); each app must keep its window in the launched process.
A custom `apps` allowlist **replaces** the defaults. `{}` permits no launches.
Both `enabled` and `apps` come only from the explicit **user** layer exposed by
`api.settings.layers("extensions")`;
project, project-local and flag layers are ignored, even when they override user values.
Without settings provenance the extension stays disabled. Configure executable paths and
optional argument arrays (`"args": ["--force-renderer-accessibility"]`) yourself; the model
can only select an allowed **name**, not supply a command or launch arguments.
Non-Windows hosts register no tools and print at most one short notice.

**D109 — user decision, 2026-10-05:** packaged Notepad/Calculator, packaged/UWP apps, and
apps that hand off to an existing process are unsupported. This includes most browsers and
VS Code when already running. Adding them to the allowlist does not make them supported.

## Safety boundary

**Only windows belonging to processes this extension launched may be read or controlled.**
Neither tools nor tests discover/read the user's existing app trees or window titles. Both
TypeScript and PowerShell reject unowned handles; PowerShell also checks the current window
PID, process creation time (PID reuse), top-level status, and the ancestry/PID of each UIA
node/ref before reading or acting. Element refs are local to the latest tree of that window.
All tools are serialized and main-session-only, avoiding competing sub-agent keyboard focus.

During launch discovery, the helper enumerates top-level window handles/PIDs to find its
own new visible top-level HWND. Ownership requires the **exact PID returned by Start-Process
and its process start time**; no other process is adopted. Foreign new-window metadata can
cause a generic launch refusal, but is not evidence of launch provenance. The helper does not
read foreign window names/content, return or log their metadata, or adopt or kill their processes.
A concurrent unrelated new window can conservatively refuse the launch; no attempt is made
to attribute that foreign window to the app. Failed-launch cleanup terminates only the exact
launched PID/start-time identity; failed kills remain journaled for retry. If the launch identity
cannot be captured, cleanup does not guess or kill; the launched app may remain running.

`ui_tree` declares `traits: { readOnly: true }`. Launch, click, type, key and close do not:
Amira's normal permission policy asks in default mode and runs in auto mode. There is no
custom approval bypass. A UIA read-only tree can still expose sensitive data you enter into
these launched apps. Do not put secrets there unless you want the model to read them.

Pattern operations are preferred. Keyboard/mouse fallback requires the owned window to be
in the foreground; an obscured clickable point is refused. `alt+f4` (including modified/case
variants) is refused: use `ui_close`. Windows-key and desktop-switching chords are unsupported.
The click fallback re-reads the actual cursor immediately before mouse-down, refuses a moved
pointer, and hit-tests that actual position. Do not compete with the agent for focus or the
pointer: Windows global input is not atomic or isolated. A **residual microsecond race for
keys** remains between the final focus check and SendInput delivery; the pointer/foreground
can likewise change after the final mouse check. Applications can themselves open external
apps/windows; those are **not** adopted or read.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `ui_launch` | `app` | Owned `window` handle string, `pid`, `title` |
| `ui_tree` | `window`, optional `depth` (default 8, 0–30), `maxNodes` (default 300, 1–1000) | One line per `eN` ref: control type, name, automation id, cheap value/toggle state, enabled/offscreen flags; cut note and traversal ms/nodes/characters |
| `ui_click` | `window`, `ref` | Invoke/Toggle/SelectionItem/ExpandCollapse pattern, else guarded clickable-point SendInput; reports path |
| `ui_type` | `window`, optional `ref`, `text` | ValuePattern.SetValue when available; otherwise focused Unicode input; reports path |
| `ui_key` | `window`, `keys` | Small single-chord syntax such as `ctrl+s`, `enter`, `shift+tab`; refuses focus failure |
| `ui_close` | `window` | WindowPattern.Close, then exact owned PID termination after a short timeout |

A new `ui_tree` replaces that window's ref map; element numbers are never reused in a helper.
Window tokens include a helper-generation ID and native HWND, so restart cannot alias an old
window token to a new window. Refresh after UI changes. Text/value fields
are escaped onto one line and bounded; trees also have a defensive 200,000-character ceiling
on the TypeScript side. Timing covers the helper traversal/rendering, not PowerShell startup
or IPC. The appended character count is the rendered node text, excluding the timing/cut note.
`ui_type` allows at most 20,000 UTF-16 code units per call. Document/Edit controls exposing
TextPattern instead of ValuePattern include a bounded `text` field (512 characters); writable
ValuePattern controls show `readonly=false`. For TextPattern-only editors, typing uses
Unicode SendInput and read-back uses TextPattern; this is **not** reported as
ValuePattern.SetValue. Unknown enabled/offscreen flags are shown as `?`.
Unreadable provider nodes are marked `unreadable`, receive no actionable helper ref, and do
not abort their siblings; an ownership/lifetime Deny still aborts the whole snapshot. Each
node's ancestry is verified once per tree, not again for each property. A cooperative **20 s**
traversal budget is checked between provider reads, leaving headroom below the TypeScript
60 s request timeout. A single synchronous provider call can still block beyond that budget;
it cannot be interrupted in-process, and the watchdog remains the last-resort cleanup path.

The helper starts lazily with `api.openPipe` and speaks one request/response JSON object per
line. It is restarted after death; old handles and refs are invalid and must be relaunched.
EOF/session end/host exit closes owned windows and then their remaining owned processes,
with creation-time checks and **no image-name kills**. Unsaved work in these apps can be lost.
Since API 0.1.27 has no unload hook and does not dispose `openPipe` on unload, a small
extension-owned background job acts as a lifetime sentinel. Amira kills that job on unload;
the helper watches its exact process identity while waiting for input, then cleans up and
exits. An independent headless watchdog, also started through `api.openPipe`, reads a private
per-client journal containing **only launch PID/creation-time identities**. It reaps those
identities after helper death. On unload/session end it gives
the helper three seconds to close gracefully, then terminates remaining recorded processes
and the helper even if a UIA provider is stuck. The sentinel's original creation time travels
with its PID to prevent PID-reuse mistakes. This lifecycle bridge adds two headless PowerShell
processes while in use; neither enumerates or reads desktop windows. A restarted helper first
cleans the previous current-schema journal and never adopts old window handles. Temporary journals are removed by
the watchdog on session end/unload. If termination cannot be confirmed, it reports incomplete
cleanup and retains the journal instead of silently forgetting the owned process identities.
Journals retain the `amira-uia-<UUID>.json` prefix (and atomic-write `.tmp` files), but require
`OwnershipVersion=2`. Old heuristic journals are ignored by stale cleanup, helper restart and
the watchdog; their recorded processes are not treated as owned. On startup the helper scans
`%TEMP%` for current-schema journals. It skips live/inaccessible helpers, validates all recorded
PID/start-time identities, kills only those exact recorded processes if necessary, and removes
a stale journal only after confirming every recorded process is gone. Invalid/unreadable
journals and failed kills are retained; journals belonging to active helpers are left alone.

## Limitations

- Requires an active connected session and an interactive, unlocked Windows input desktop.
  Session 0, disconnected RDP sessions, headless and locked desktops are not supported. Elevated apps and secure desktops are not supported; run at matching
  integrity levels and do not use this to operate permission prompts.
- Child dialogs such as **Save As cannot be driven**: their separate top-level HWND is not
  the exact window returned by `ui_launch`, even if the PID is the same. Input is refused
  while that dialog has focus. **`ui_close` still works** and can terminate the recorded app
  process, including its dialog; unsaved work may be discarded.
- Electron apps generally need `--force-renderer-accessibility`. Custom-drawn controls may
  expose little or no UIA tree; stale providers and expensive UIA calls can fail or time out.
- This uses the managed .NET `System.Windows.Automation` client (commonly called **UIA2**),
  not COM UIA3. Some providers behave differently or lack ValuePattern;
  there is no UIA3/FlaUI dependency and no screenshot fallback. Typing then uses guarded
  Unicode keyboard input, not a pretend ValuePattern success.
- Packaged/UWP apps and process hand-offs are unsupported (D109). Multi-window,
  multi-process, single-instance reuse, and arbitrary application activation chains are not
  generally supported. Closing kills only recorded process identities, never by executable
  name. A machine crash or forced termination of both helper and watchdog may leave an app
  alive; a foreign process is never adopted or killed speculatively.
- Allowlisted apps can access files/network and respond to keys in application-specific ways.
  The window guard is not an application sandbox. UIA calls are synchronous; cancellation
  before a tool starts is honored, but an already-issued pattern action cannot be rolled back.

## Tests and measurements

```sh
bun scripts/link-amira.ts D:/dev/Amira
bunx tsc --noEmit
bunx biome check src test scripts package.json tsconfig.json biome.json
bun test test
bun scripts/smoke.ts   # explicit launch/tree/type/read-back/close run, owned apps only
```

Tests are updated for D109 to target the deterministic bundled WinForms `testWindow`, not
Notepad or Calculator. Unit tests use a fake JSON-line helper to cover launch refusals,
ownership/allowlist/ref guards, permissions, cutting, lazy restart, timeout and session
cleanup, user-only settings provenance, and the entry-point export snapshot.
The desktop tests probe the input desktop **without enumerating windows** and automatically
skip desktop work on other platforms or when no interactive desktop is available. With an
interactive desktop, they launch only the bundled window for tree/type/read-back/key/close,
extension-host unload and helper-crash cleanup checks. Desktop-free helper **source contract
tests** cover exact launched-PID ownership, foreign-window refusal, failure cleanup,
`OwnershipVersion=2` journal safeguards, cursor checks and tree budgets/provider errors;
they are not runtime PowerShell/provider tests. The explicit smoke script also targets the
bundled window. Never test against a window you did not launch.

**D109 verification status:** tests have not been run for this change; verification is limited
to TypeScript and Biome checks. No current desktop measurements or runtime success are claimed.

Provider initialization is called through a typed, non-inlined frame: the managed UIA
[default proxy loader](https://source.dot.net/UIAutomationClient/MS/Internal/Automation/ProxyManager.cs.html)
walks `ReflectedType` on its calling stack, which PowerShell's dynamic methods do not have.
Loading the built-in proxies this way restores Win32 document/control types without
registering custom providers or querying any desktop windows.
