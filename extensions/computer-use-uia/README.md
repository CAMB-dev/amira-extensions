# computer-use-uia

> **Experimental 0.0.2 — Windows only, off by default.** This extension can read and control
> **any window**, including apps you already have open. It is not an application sandbox.
> Interfaces and safety limits may change. Do not enable it unless you accept the risks below.

Uses Windows PowerShell 5.1 and the built-in .NET UI Automation client (UIA2), with no
screenshots, OCR, native npm modules or shipped compiled binaries. P/Invoke and the WinForms
pointer use small in-memory C# shims. Requires **Amira ^0.1.28**.

**D112 supersedes D109:** there is no launch allowlist or launched-window-only read/action rule.
The old `apps` setting is removed. Reading or controlling a window does **not** make its process
eligible for termination.

## Risks and permissions

- Window titles, UIA names, text and values from **any app** may be read and sent to your model
  provider. This can include private documents, messages and account details. Password controls
  report `password=true` and do not query ValuePattern/TextPattern values. Edit/Document controls
  with an unknown password flag report `password=unknown` and also hide their values; other
  sensitive fields are not automatically redacted. A provider that mislabels secrets can still expose them.
- In **auto mode**, desktop actions can run **without asking**, including launching arbitrary
  programs, entering text, clicking controls and closing windows. Amira's normal permission
  policy applies; there is no extension-specific approval path. Only `ui_windows` and `ui_tree`
  declare `readOnly`; all other tools are actions.
- Actions can modify files, send messages, make purchases or trigger other application-specific
  effects. Closing a window or cleanup of a launched app can discard unsaved work.
- Screen content is **untrusted data**, not instructions. Both read-tool descriptions and their
  results explicitly mark it as such. Do not ask the agent to follow instructions it finds in an app.
- Keyboard/mouse fallback uses Windows global input. Do not compete for focus or the mouse.
  Target-window focus and cursor hit-test checks reduce risk, but cannot eliminate the race
  between checking and delivering input. Already-delivered input/pattern actions cannot be undone.

All tools are serialized and main-session-only. UIA patterns are preferred and **do not move the
real mouse**. Mouse fallback checks the target's foreground status and clickable point, then
rechecks the actual cursor position and hit test immediately before mouse-down. Keyboard fallback
checks the focused native control belongs to the target window. Element refs are window-local,
validated against the target window, and replaced by each new tree.

## Enable and settings

Install with `amira ext install computer-use-uia`, then opt in in **`~/.amira/settings.json`**:

```json
{
  "extensions": {
    "computer-use-uia": {
      "enabled": true,
      "overlay": true,
      "stopHotkey": "ctrl+alt+q"
    }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Register desktop tools on Windows |
| `overlay` | `true` | Run the virtual pointer, action banner and emergency-stop monitor; `false` disables all three |
| `stopHotkey` | `ctrl+alt+q` | Emergency stop; ctrl/alt/shift modifiers plus a letter, digit or F1–F12 |

Settings come **only from the explicit user layer** of `api.settings.layers("extensions")`.
Project, project-local and flag layers cannot enable desktop access or change the stop monitor.
Hosts without settings provenance remain disabled. Non-Windows hosts register no tools.
An old `apps` entry is ignored; it no longer restricts launches or window access.

On layouts with **AltGr**, the default **Ctrl+Alt+Q** can also match **AltGr+Q**
(for example, `@` on a German keyboard). To avoid stopping while typing it, set
`stopHotkey` in your user settings to another chord, such as `"ctrl+shift+f12"`.
The default remains unchanged.

## Stop and resume

With the overlay enabled, press **Ctrl+Alt+Q** (or your configured chord), or press
**Esc twice within 500 ms** while an action is running or within **three seconds after it ends**.
Outside that control window these keys do not stop desktop control. Escape detection uses physical
key-down edges from the low-level keyboard hook and ignores both injected-input flags; a model-sent
`ui_key escape` cannot trigger the stop. Input is not swallowed and the monitor does not take focus.

Keyboard/mouse low-level hooks are installed **during actions and the three-second post-action
window**, then removed when idle. Anti-cheat software may notice these global hooks; do not enable
this extension while gaming or using software that prohibits input hooks. The chord uses
`RegisterHotKey`, not a hook, and remains registered while the overlay process is alive.

If registration fails, the error is **“Stop hotkey ctrl+alt+q is unavailable — set stopHotkey or
disable the overlay”** (with your configured chord). Other startup failures report their real error.
These failures are **not user stops** and do not latch. `ui_windows` and `ui_tree` still work without
an overlay; actions require a working stop monitor and retry startup on the next action.

Set **`overlay: false` explicitly** to disable the pointer, banner, hotkey, Escape stop and low-level
hooks together. Actions then run **without an overlay-based emergency stop or independent input
release monitor**. Normal tool cancellation still works, but already-delivered input cannot be undone.
Set `enabled: false` to disable all desktop tools.

Stopping immediately terminates the **exact helper PID/creation-time identity**, including when a
synchronous UIA provider blocks. The model receives **“the user stopped desktop control”**. Further
actions are refused until you run **`/uia resume`**. Cancelling an in-flight action (including an
action timeout) also latches the stop; cancelling `ui_windows` or `ui_tree` does **not**. Cancelling
a queued read neither runs that read nor interrupts another request. New or queued messages do
not resume control. Read tools remain available while stopped; they may start a fresh helper/monitor,
but do not clear the action latch.
A system-prompt notice also tells the model that control is stopped. Use `/uia resume` only when
you want actions to be allowed again.

Stop is not rollback: an action already issued may have completed, and typing may be partial.
Clicks/chords use a single native input batch; with the overlay enabled, an independent input-hook
ledger releases only observed extension-injected downs after interruption, without releasing
physically held user keys. The hidden release-only monitor can retain hooks for up to four additional
seconds during idle/interruption cleanup to retry
transient failures. If releases still fail (for example across a secure-desktop transition), Amira
reports incomplete input cleanup; release any held keys/buttons manually before resuming.
Inspect the target app before resuming. Emergency stop kills the exact helper and only launched
job members with **no windowed protector of their own and no live, older windowed ancestor within
that job**, following PID/creation-time ancestry up to the launch root. Job membership proves
ownership; an exited ancestor, a broken chain, an ancestor outside the job, or a reused PID that
is not strictly older grants no protection. Ancestor access/API failures are not proof of a broken
chain: that candidate is skipped and cleanup is reported incomplete; other candidates are still checked.
A .NET process-already-exited exception is treated as an exit, not an access failure. Ancestors are
opened with limited query access for exit, creation-time and job-membership checks; they are never
opened with all-access rights.
“Windowed” means a visible top-level window with non-zero bounds intersecting the virtual screen.
A **minimized window protects** if it is not a tool window and its saved normal placement, converted
from workspace to screen coordinates, is non-empty and intersects the virtual screen. Apps that minimize to the tray hide their window and are **not
protected** by that hidden window or tray icon. DWM shell-only cloaking (including windows on another
virtual desktop) is allowed;
app/inherited cloaking, including combinations with shell cloaking, is not. Layered windows whose
reported global alpha is zero are excluded even when minimized. This is a **heuristic**, not proof
that you can see or use the app:
per-pixel transparency, occlusion and unusual window styles may still fool it.
Launch roots younger than **three seconds** (and their members) are skipped and reported as
**“still starting (3 s grace)”**; stop does not schedule a later kill. **“Launch root registration
pending”** is reported separately and means the job's members were preserved; failed/pre-commit
or completed rootless launches are drained and discarded.
This preserves windowed apps and their
Chromium/Electron/WebView2 GPU, renderer and utility children. Windowed apps remain open until
you close them or end the session. Session cleanup terminates the entire launched tree and can
lose unsaved changes. Apps that were already open, including unrelated handoff targets, are
never terminated just because the extension read or acted on them.

## Virtual pointer

Before each action the helper sends a physical-pixel UIA clickable point, or bounds center, to a
**separate PowerShell WinForms process** and awaits a glide acknowledgement for up to **five seconds**.
If the overlay is slow, the helper logs the timeout and skips that action's animation wait; it does
not stop control or kill apps. The pending pipe read is retained to consume a late acknowledgement.
The purple
Amira pointer has a small label, a 320 ms ease-out glide, click ripple, typing indicator and key
chord badge. During actions a thin primary-screen banner reads:

> Amira is controlling the desktop — Ctrl+Alt+Q to stop

The chord in the banner follows your setting. The overlay covers the full virtual desktop,
including negative monitor coordinates, using per-monitor DPI awareness. Its transparent,
layered, topmost, toolwindow and no-activate styles keep it click-through, out of Alt+Tab and
away from keyboard focus. It hides after three idle seconds, and exits with the helper/session.
Setting `overlay: false` prevents the overlay/stop-monitor process from starting. This is a **virtual** pointer: pattern
operations never reposition your real cursor.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `ui_windows` | optional `filter` | Up to 200 visible top-level `windows`: native handle (`window`), title (120 characters), process name, PID, class, physical bounds, minimized/foreground state. Case-insensitive substring across these identifiers; a `cut` flag/note reports truncated output. |
| `ui_tree` | `window`, optional `depth` (8, 0–30), `maxNodes` (300, 1–1000) | Any target window's UIA tree, unique snapshot refs, names, flags, bounded values/text, password flags, and timing/size footer |
| `ui_launch` | `command`, optional string-array `args`, `cwd` | New PID plus an unambiguous new window, or a PID and instruction to use `ui_windows` |
| `ui_click` | `window`, `ref` | Invoke/Toggle/SelectionItem/ExpandCollapse pattern, otherwise guarded clickable-point input; reports path |
| `ui_type` | `window`, `text`, optional `ref` | ValuePattern.SetValue or guarded focused Unicode input; reports path |
| `ui_key` | `window`, `keys` | Single chord such as `ctrl+s`, `enter`, `shift+tab`; refuses desktop-switching chords and `alt+f4` |
| `ui_focus` | `window` | Restore a minimized window and bring it to the foreground; refuses focus failure |
| `ui_close` | `window` | WindowPattern.Close or asynchronous WM_CLOSE; reports whether the window closed |

`ui_launch` accepts program names/paths and arguments, not an allowlisted name. It launches
without a shell/console. Discovery looks for a new visible window in the launched PID, or a new
window whose process executable name matches the command (for handoff apps such as packaged
Notepad). A 500 ms stable, single match returns the native handle and `windowPid`; handoff
matches are explicitly marked. Multiple matches, existing-window reuse, inaccessible identity
or no match return the launch PID and an instruction to use `ui_windows`. Executable-name
correlation is **not proof of launch ownership**. Discovery never grants kill eligibility;
actual descendants remain owned through their launch job, not executable-name matching.

Use filtered `ui_windows` to select the intended target, including existing apps and separate
child dialogs. Refresh `ui_tree` after UI changes. Handles may be recycled by Windows; old refs
are invalid after helper death, closing or a new snapshot. Trees are bounded by node/depth
limits, a cooperative 20 s traversal budget and a 200,000-character TypeScript ceiling.
Unreadable nodes receive no actionable ref and do not prevent reading siblings. Text fields
are escaped onto one line and limited to 512 characters. `ui_type` accepts at most 20,000
UTF-16 code units. A single synchronous provider call can still exceed the traversal budget.

`ui_close` only requests WindowPattern.Close/WM_CLOSE and reports **closed or still open** after
its brief observation wait; a save prompt may remain. It **never force-kills**, even for an app
launched by this extension. Exact PID/creation-time kills of still-running launched processes are
reserved for **session cleanup** and the headless-member emergency-stop rule above.
There are no image-name kills.

`ui_close`, `ui_focus`, `ui_click`, `ui_type` and `ui_key` refuse desktop/taskbar shell classes
(`Progman`, `WorkerW`, `Shell_TrayWnd`, `Shell_SecondaryTrayWnd`), the overlay's own native window,
and identifiable Amira console/terminal windows (Amira PID/ancestor identities and console HWND).
Reads can still list and inspect them. Terminal-host identification is best effort; native window
ownership varies between console hosts.

## Lifecycle

The helper and overlay start lazily through `api.openPipe`. A headless extension-owned lifetime
sentinel bridges host unload, and a separate headless watchdog can clean up while UIA is blocked.
Exact launch PID/start-time records, the helper identity and opaque job IDs are atomically
journaled in `%TEMP%/amira-uia-<UUID>.json` (`OwnershipVersion=3`), with no titles, screen text
or action history. Every write carries an HMAC-SHA256 over the exact serialized content, including
a per-session nonce and the state path. A new random 32-byte key and nonce are generated with
each client session's state path; helper replacements reuse that session's credentials. Replacing
a lost watchdog starts a fresh state path/key/nonce generation, never adopting its lost jobs. The key
stays in memory and reaches the helper/watchdog only over stdin, never argv, environment or
files. Readers verify the MAC, nonce and path before trusting any identity. Untrusted records
are ignored with **“untrusted launch journal; cleanup refused”** and grant no cleanup authority;
they cannot block later launches. No other clients' journals are scanned. Reading, focusing,
clicking, or executable-matching a window never adds a launch record.

The watchdog creates an **unnamed, non-breakaway Windows job** before launch and transfers a
assignment-only job handle and a limited parent-process handle only to the verified helper PID/start-time identity.
The helper closes both duplicated handles when a requested transfer acknowledgement arrives late
or is rejected. Acknowledgements for job IDs this helper never requested are ignored without closing
any echoed handle numbers.
The helper validates the parent's PID/creation time and assigns **both the job and the watchdog
as OS parent atomically** during suspended creation. Launched apps are children of the session
watchdog, not the transient helper, so even a host-level helper tree kill cannot reach them.
No public job names or journal-supplied handles are opened. Closing job handles does not implicitly kill apps: termination requires explicit cleanup
by the watchdog holding those exact handles. After the helper journals the suspended root, the
watchdog verifies its exact identity and primary-thread ownership, then registers and resumes it
before acknowledging the launch. Helper death cannot leave a registered root indefinitely suspended;
a lost acknowledgement does not authorize killing a launch the watchdog already committed.
Failure to retain/assign the job (including unsupported
nested jobs) refuses the launch instead of running it untracked. Tracked processes are the launched
process and **directly created process-tree descendants that remain in its job**, even if the
launcher exits. This does **not** track processes created by external brokers: WMI
`Win32_Process.Create`, `schtasks`/scheduled tasks, DCOM or explorer-mediated ShellExecute,
COM/ShellExecute to an existing instance, or services. Discovery never turns these into owned
processes. Emergency stop checks exact UTC FILETIME creation identities, job membership,
visible-window ancestors and the three-second root-start grace described above. Session end
terminates the whole job, polls for exit for two seconds, and retries once if incomplete.

Helper EOF, request timeout and helper restart **do not clean up launched apps**. Helpers are
retired through PID/creation-time-checked, non-tree termination; their pipe is closed only after
confirmed exit. If the watchdog dies, a headless exact-helper reaper is used, never a tree kill.
Retirement failure or a ten-second retirement timeout refuses replacement and reports the error
instead of hanging requests; session teardown still drains the watchdog and its retained jobs.
After that exact old helper's native exit is confirmed, `/uia resume` followed by a tool request
(or the next read/start) can retry the retirement gate. Until exit is confirmed, replacement stays
refused; resume alone does not permit overlapping helpers.
The watchdog holds jobs across helper replacement; restarted helpers read only their own client's authenticated
journal and invalidate old window refs. Session end, host exit/unload, watchdog EOF,
**`/jobs stop` on the computer-use-uia lifetime job**, and **extension reload** end the launched
apps, including windowed apps with unsaved changes. **Extension reload does not call the client's
`stop()` method**: cleanup relies on the extension-owned sentinel dying and the watchdog's
**three-second grace** before terminating its retained jobs. Stopping the lifetime sentinel signals the
watchdog to terminate its retained jobs; a watchdog tree kill at session end also reaches the
launched trees by design. The watchdog pins the current helper identity over its private
client pipe, once per helper generation, checks the spawned child's PID and native creation time,
and acknowledges that identity before the helper's first journal write. Cleanup retires that exact
helper before verifying the final snapshot. Missing, stale or untrusted journals **never prevent
cleanup of jobs the watchdog itself retained**; journal-supplied identities grant no kill authority.
A complete session cleanup removes the journal and `.tmp`; unverifiable/incomplete cleanup retains
the journal and reports the failure. Existing windows are not closed during teardown.
Rotated journals are deleted after the old generation's cleanup finishes or its watchdog is
confirmed gone, when lost unnamed job handles make further cleanup impossible; they are kept
only while they can provide evidence for active cleanup. A missing journal before the first write,
or a retired writer's snapshot before replacement writes, is not reported as incomplete when
all retained jobs were drained. On a non-force emergency stop, windowed members deliberately
preserved during a journal gap do not count as incomplete cleanup.
The overlay watches the exact helper and sentinel identities and exits on pipe EOF.
**Hard-killing only the watchdog process does not clean up launched apps.** Job handles have no
kill-on-close behavior, and the journal cannot recover lost kernel job handles. Killing the
**watchdog's entire process tree**, in contrast, also kills its launched apps.

Invoke/Toggle/SelectionItem/ExpandCollapse/SetValue, WindowPattern.Close and element SetFocus run
on background threads with a **five-second wait**. If a click/type provider remains busy, the
helper returns **“action timed out; it may still be running or the target may be busy — use
ui_windows”** and remains available to locate the dialog. Timeout cancels an action still in
preflight, so it cannot dispatch later; it cannot cancel or roll back a UIA call already entered.
A focus timeout refuses subsequent input. A bounded number of busy pattern calls is allowed;
additional calls are refused until one finishes.

## Limitations

- Requires Windows 10 version 1607 or later, and an active, connected, unlocked interactive desktop. Secure desktops,
  Session 0 and disconnected RDP sessions are unsupported.
- **Elevated windows are inaccessible from a non-elevated helper.** Do not use this to operate
  UAC/security prompts. UIA/input may fail across integrity levels.
- Electron apps often need **`--force-renderer-accessibility`** in their launch arguments.
- Games, canvas apps and custom-drawn controls often expose sparse or empty UIA trees. There
  is no screenshot/OCR fallback. Providers can be stale, expensive or hang.
- UIA2 behavior varies by provider. Some editors expose TextPattern rather than writable
  ValuePattern; these use guarded Unicode input, not a pretend SetValue success.
- A UIA tree can expose cross-process children/popups. Reads may include these, but an action
  ref must still belong to the selected target top-level HWND. Use `ui_windows` to select a
  separate popup/dialog instead of assuming it is part of the old target.
- Global hotkey availability, DPI mapping, overlay hit-testing, focus/pointer races and abrupt
  provider interruption require real Windows validation; source contracts cannot prove them.

## Verification and desktop test safety

Safe fake-only checks (no desktop/helper/hotkey processes):

```sh
bunx tsc --noEmit
bunx biome check src test scripts package.json tsconfig.json biome.json
bun test ./test/unit.test.ts ./test/helper.test.ts ./test/safety.test.ts
```

`unit.test.ts` uses fake host/jobs/pipes for settings, tool traits, arbitrary handles/launches,
window-local refs, emergency-stop latching/explicit resume, startup-stop races, timeout aborts,
untrusted-result framing, model-facing stop notices and overlay protocol/lifecycle. `helper.test.ts`
reads source files only: these contracts are **not PowerShell runtime or provider tests**.

Desktop tests are **explicitly opt-in**. Do not run them while anyone is using the machine.
Importing/skipping `desktop.test.ts` starts no probes or processes. On a dedicated idle Windows
machine, set `AMIRA_UIA_DESKTOP_TESTS=1` and run `bun test ./test/desktop.test.ts` (or the explicit
`scripts/smoke.ts` wrapper). Tests use only their uniquely titled bundled test window and their
own overlay/helper processes, filter `ui_windows` before acting, and never log other windows'
titles. Their overlay runs with **`-TestMode`**, which does not register hotkeys or detect physical
Escape stops; stop is simulated over its private pipe. Neither test nor real helpers scan other
clients' journals. Every launched process is cleaned up in
`finally`, through exact identities, never by image name. Coverage includes a test-started fixture
not launched through the extension (it must remain ineligible for termination), real-cursor
preservation for pattern actions, glide ID/timing checks and idle hiding. For the mixed-DPI test,
configure a negative-coordinate secondary monitor at a different scale and set
`AMIRA_UIA_TEST_LEFT` / `AMIRA_UIA_TEST_TOP` to a location fully inside that monitor. This test
also checks that helper death removes the monitor but preserves the fixture across restart. No test registers a stop
hotkey; input-release hooks observe the test helper's tagged input only during actions and the
post-action window. Desktop coverage also checks idle hook removal, explicit overlay opt-out,
polite close of an IgnoreClose fixture, delayed acknowledgements, protected test-owned targets,
title truncation, modal dialogs, windowed-app survival on stop, and headless descendant cleanup.
Simultaneous loss of helper and watchdog can leave a launched tree running; no replacement
reopens an unverified kernel object, and rotation removes the unrecoverable old journal.
Do not use blanket `bun test` as a
substitute for the explicit fake-only paths on a live desktop.
