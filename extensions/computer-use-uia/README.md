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
      "enabled": true,
      "apps": {
        "notepad": { "command": "notepad.exe" }
      }
    }
  }
}
```

`enabled` defaults to `false`, even after installation. Omitting `apps` permits only Notepad;
supplying it **replaces** the defaults. `{}` permits no launches. Both `enabled` and `apps`
come only from the explicit **user** layer exposed by `api.settings.layers("extensions")`;
project, project-local and flag layers are ignored, even when they override user values.
Without settings provenance the extension stays disabled. Configure executable paths and
optional argument arrays (`"args": ["--force-renderer-accessibility"]`) yourself; the model
can only select an allowed **name**, not supply a command or launch arguments.
Non-Windows hosts register no tools and print at most one short notice.

Calculator is **not a default app**: stock Windows 11 Calculator is refused before launch
because its window uses shared ApplicationFrameHost. You can explicitly add
`"calculator": { "command": "calc.exe" }` to your user allowlist, but it may not work.
Missing/inaccessible package or manifest information also causes refusal before launch;
only positively identified full-trust Calculator packages with a matching executable pass
preflight, and they must still satisfy the hand-off discovery checks.

## Safety boundary

**Only windows belonging to processes this extension launched may be read or controlled.**
Neither tools nor tests discover/read the user's existing app trees or window titles. Both
TypeScript and PowerShell reject unowned handles; PowerShell also checks the current window
PID, process creation time (PID reuse), top-level status, and the ancestry/PID of each UIA
node/ref before reading or acting. Element refs are local to the latest tree of that window.
All tools are serialized and main-session-only, avoiding competing sub-agent keyboard focus.

Internally during launch discovery, the helper **enumerates top-level window handles/PIDs
and process paths to find its own new window**. It does not read other windows' titles or UIA
trees; nothing about other windows is returned to the model or logged. Ordinary launches
require the exact PID/creation time returned by Start-Process and a new visible top-level HWND.
For packaged-app hand-off, the known mappings are `notepad.exe` → `Notepad.exe` and
`calc.exe` → `CalculatorApp.exe`, restricted to the corresponding Microsoft WindowsApps
package. New matching process identities are journaled immediately, even before a visible
window appears, so the watchdog can clean them up if discovery fails. Every failed launch
terminates its launcher and journaled matches by exact PID/start time; failed kills remain
journaled for retry rather than being forgotten.

A hand-off window is adopted only after the launcher stub exits, with the candidate's process
start time between the launcher's start and three seconds later. Available native parent
information must match the launcher; brokered activation with a different parent is refused
because this helper has no activation token to correlate it. The window must also remain the
sole match for 500 ms. Already-running/single-instance hand-offs, unknown targets and ambiguous
matches are refused. An existing/shared frame host is never adopted. You may need to close an
already-running instance **yourself** first; do not use apps that hand work to an existing process.

**Remaining adoption race:** when parent information is unavailable, path/start-time matching
and an exited stub are still a heuristic, not proof of activation provenance. A concurrent
independent launch of the same packaged app can match the discovery journal and may be adopted
or terminated during failed-launch cleanup. Even available parent PIDs lack an activation token.
Do not launch the same app concurrently while discovery is running. This experimental guard
is conservative, not a general process-provenance sandbox.

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
ValuePattern controls show `readonly=false`. Notepad's multiline editor commonly exposes
TextPattern only, so typing uses Unicode SendInput and read-back uses TextPattern. This is
**not** reported as ValuePattern.SetValue. Unknown enabled/offscreen flags are shown as `?`.
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
identities after helper death (including packaged hand-offs). On unload/session end it gives
the helper three seconds to close gracefully, then terminates remaining recorded processes
and the helper even if a UIA provider is stuck. The sentinel's original creation time travels
with its PID to prevent PID-reuse mistakes. This lifecycle bridge adds two headless PowerShell
processes while in use; neither enumerates or reads desktop windows. A restarted helper first
cleans the old journal and never adopts old window handles. Temporary journals are removed by
the watchdog on session end/unload. If termination cannot be confirmed, it reports incomplete
cleanup and retains the journal instead of silently forgetting the owned process identities.
On startup the helper also scans `%TEMP%` for this extension's `amira-uia-<UUID>.json` journals
(and atomic-write `.tmp` files). It skips live/inaccessible helpers, validates all recorded
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
  not COM UIA3. Some modern WinUI/UWP providers behave differently or lack ValuePattern;
  there is no UIA3/FlaUI dependency and no screenshot fallback. Typing then uses guarded
  Unicode keyboard input, not a pretend ValuePattern success.
- Packaged UWP/WinUI launch hand-off is restricted as described above. Multi-window,
  multi-process, single-instance reuse, and arbitrary application activation chains are not
  generally supported. Closing kills only recorded process identities, never by executable
  name. A machine crash, forced termination of both helper and watchdog, or a crash before a
  packaged hand-off PID can be resolved may leave an app alive; an unproven process is never
  adopted or killed speculatively.
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

Unit tests use a fake JSON-line helper and cover ownership/allowlist/ref guards, permissions,
cutting, lazy restart, timeout and session cleanup, and the entry-point export snapshot.
The desktop tests probe the input desktop **without enumerating windows** and automatically
skip desktop work on other platforms or when no interactive desktop is available. On Windows
they also check helper-side refusals without touching any app. With an interactive desktop,
they launch their own Notepad, set/read Unicode text using native ValuePattern when available
or the documented Unicode/TextPattern fallback otherwise, verify snapshot/key guards, close it,
and verify real extension-host unload and helper-crash cleanup. The tests do not skip merely
because ValuePattern is absent: they report the actual path, without claiming native
ValuePattern coverage. Desktop-free helper **source contract tests** cover discovery journal
ordering, failure cleanup, correlation checks, cursor checks, tree budgets/provider errors and
stale-journal safeguards; they are not runtime PowerShell/provider tests. Unit tests also cover
user-only settings provenance and Calculator opt-in. The explicit smoke script opts into
Calculator and reports its launch refusal as a **skip, not a failed smoke run**; supported apps
still report tree nodes/characters/milliseconds, and Notepad/read-back/close failures still
fail the run. Never test against a window you did not launch.

The Windows verification here found Notepad exposing TextPattern, and legacy UWP Calculator
requiring a shared frame host. Accordingly, **native Notepad ValuePattern round-trip and
Calculator tree timing were not verified**; the owned Notepad fallback was exercised instead.

Provider initialization is called through a typed, non-inlined frame: the managed UIA
[default proxy loader](https://source.dot.net/UIAutomationClient/MS/Internal/Automation/ProxyManager.cs.html)
walks `ReflectedType` on its calling stack, which PowerShell's dynamic methods do not have.
Loading the built-in proxies this way restores Win32 document/control types without
registering custom providers or querying any desktop windows.
