# computer-use-uia

> **Experimental 0.2.0 — Windows only, off by default.** This extension can read and control
> **any window**, including apps you already have open. It is not an application sandbox.
> Interfaces and safety limits may change. Do not enable it unless you accept the risks below.

**D113: screenshot-first perception, Windows only.** Every successful target observation
(`ui_tree`) returns a bounded PNG screenshot by default. Dense UIA trees also supply a text
summary with element IDs; sparse trees are omitted automatically. `ui_windows` is metadata-only
target discovery, not an observation, and never captures the desktop. Screenshots can be
explicitly disabled for tree-only operation.

Uses Windows PowerShell 5.1, the built-in .NET UI Automation client (UIA2), and
System.Drawing/Graphics.CopyFromScreen. No OCR, native npm modules or shipped compiled binaries.
P/Invoke, capture and the WinForms pointer use small in-memory C# shims. Requires **Amira ^0.1.28**.

> **Screenshot privacy warning:** password-field hiding applies only to UIA text. Images are
> **not redacted** and can reveal passwords, revealed-password widgets, recovery codes, private
> documents, and anything else visible in the target window—even when the tree hides it.
> Screenshots are sent to the model provider and may persist in session history. Disable
> `screenshot` before observing sensitive apps; there is no automatic image redaction.

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
  policy applies; there is no extension-specific approval path. Only `ui_windows`, `ui_tree`, `ui_find` and `ui_wait`
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
validated against the target window, and replaced by each new `ui_tree` or `ui_find` snapshot or successful element `ui_wait`.

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
| `screenshot` | `true` | Include a target-window PNG with every successful `ui_tree`; `false` retains trees even when sparse |
| `screenshotMaxEdge` | `1280` | Maximum PNG edge in pixels; integer 128–4096; never upscale |
| `treeDensityThreshold` | `12` | Include tree text when at least this many readable, on-screen UIA descendants are observed; integer 0–1000; 0 always includes it |

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
These failures are **not user stops** and do not latch. `ui_windows`, `ui_tree`, `ui_find` and `ui_wait` still work without
an overlay; actions require a working stop monitor and retry startup on the next action.

Set **`overlay: false` explicitly** to disable the pointer, banner, hotkey, Escape stop and low-level
hooks together. Actions then run **without an overlay-based emergency stop or independent input
release monitor**. Normal tool cancellation still works, but already-delivered input cannot be undone.
Set `enabled: false` to disable all desktop tools.

Stopping immediately terminates the **exact helper PID/creation-time identity**, including when a
synchronous UIA provider blocks. The model receives **“the user stopped desktop control”**. Further
actions are refused until you run **`/uia resume`**. Cancelling an in-flight action (including an
action timeout) also latches the stop; cancelling `ui_windows`, `ui_tree`, `ui_find` or `ui_wait` does **not**. Cancelling
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
Inspect the target app before resuming. **D113 emergency stop kills the exact helper and only
windowless members of process trees the extension itself launched.** A process's own visible
window protects that process, including when minimized; a windowed parent does **not** protect
its windowless children. Consequently Chromium/Electron/WebView2 renderers, GPU and utility
workers without their own visible windows may be terminated even though the app window stays
open. Stop is not a promise that the surviving app remains usable.

Emergency-stop cleanup goes to the current watchdog **and** the independent custody owner,
which checks all retained watchdog generations. Old windowless workers are not exempt after a
watchdog replacement; old windowed/minimized processes still get the same per-member protection.
Exact-helper retirement starts immediately. Custody's completion pass runs **after** that
retirement is confirmed and after the current watchdog's drain/exit checkpoint. Unconfirmed
retirement, custody failure or overdue confirmation reports explicit incomplete cleanup.
A stop arriving while a pass is pending queues another post-retirement pass; the stopped latch
never suppresses a later retry. Reads/restarts follow the live cleanup gates, including queued
passes, rather than just one captured acknowledgement promise.

Only retained launch-job handles grant ownership. Each candidate's PID/creation-time identity,
job membership and own windows are checked again before termination; foreign processes are
never eligible. Candidate API failures preserve that candidate and report incomplete cleanup,
without protecting its children or preventing other candidates from being checked.
Each job gets up to three termination passes followed by a read-only completion scan, with a
cooperative three-second budget. Follow-up scans catch workers created during another worker's
termination and repeat the same identity/job/own-window checks. Persisting eligible members,
API failures or budget exhaustion report **incomplete** cleanup; there is no whole-job
termination fallback or ongoing monitor for later worker creation. Individual native calls may
still exceed the cooperative budget.
A .NET process-already-exited exception is treated as an exit, not an access failure.
“Windowed” means a visible top-level window with non-zero bounds intersecting the virtual screen.
A **minimized window protects** when visible with non-empty saved normal placement, including
`WS_EX_TOOLWINDOW` windows and placement off the virtual screen (for example, after unplugging a monitor). Only
restored windows require an on-screen intersection; minimized placement needs no coordinate conversion.
Apps that minimize to the tray hide their window and are **not protected** by that hidden window or tray icon. DWM shell-only cloaking (including windows on another
virtual desktop) is allowed;
app/inherited cloaking, including combinations with shell cloaking, is not. Layered windows whose
reported global alpha is zero are excluded even when minimized. This is a **heuristic**, not proof
that you can see or use the app:
per-pixel transparency, occlusion and unusual window styles may still fool it.
Launch roots younger than **three seconds** (and their members) are skipped and reported as
**“still starting (3 s grace)”**; stop does not schedule a later kill. **“Launch root registration
pending”** is reported separately and preserves genuinely pending jobs. For a retained rootless
job, custody confirms abandonment only when **both exact original producer handles** report
exit. It then applies the same bounded per-member cleanup instead of exempting the suspended
process forever. Live/missing producer references preserve the pending job; unverifiable exit
checks preserve it and report incomplete cleanup. No journal PID lookup or whole-job emergency
termination is used. Normal failed/pre-commit cancellation still drains the current watchdog's
uncommitted launches.
Windowed processes remain open until you close them or end the session; their windowless
workers are not protected. Session cleanup terminates the entire launched tree and can
lose unsaved changes. Apps that were already open, including unrelated handoff targets, are
never terminated just because the extension read or acted on them.

## Target screenshots and coordinates

Capture uses only the chosen top-level window's physical DWM extended-frame bounds, validated
inside `GetWindowRect` (excluding invisible resize borders on maximized windows), never an
implicit whole-desktop capture. This extension does not offer whole-desktop capture.
Observations do not focus or restore windows. Hidden, minimized, cloaked, layered/transparent,
partly offscreen (including monitor gaps), excessively large, or occluded targets are refused;
make the intended window fully visible yourself or explicitly disable screenshots. A failed
capture is an error, not a silent tree-only observation. Intermediate captures are bounded to
64 megapixels and 32,768 pixels per dimension. The extension's own overlay hides and acknowledges
before capture while its stop monitor remains active. A failed/timed-out hide handshake retires
that exact overlay without changing the stop latch, **even when already stopped**; the next
observation starts a fresh overlay and retries. Read recovery never resumes desktop actions.

CopyFromScreen is not a private offscreen renderer: overlapping windows can expose unrelated
pixels. Conservative pre/post visibility, occlusion and geometry checks reduce that risk, but
cannot eliminate races while another app moves. Custom nonrectangular window regions are
refused; four conservative 16-logical-pixel corner squares are blacked out before downscaling,
using the highest physical monitor scale intersected by the frame (not the app's potentially
virtualized DPI), to avoid exporting pixels behind DWM-rounded corners. Unusual glass/composited transparency
may still expose underlying content: this is not a private renderer. Never observe a sensitive
window assuming password flags or target bounds guarantee redaction or isolation.

PNG output never upscales and has a configurable maximum edge. Width and height round down
independently, so the response reports actual `scaleX = imageWidth / physicalWidth` and
`scaleY = imageHeight / physicalHeight`, plus bounds and effective monitor DPI (the highest
intersected monitor scale × 96, which need not equal a DPI-unaware app's reported 96 DPI). For example a 1920×1080
window at physical origin (−1920, 100), downscaled to 1280×720, maps screenshot (640, 360)
to physical (−960, 640): `origin + floor(imageCoordinate / axisScale)`. **Do not apply another
DPI multiplier**. Pass image pixels and the screenshot ID to `ui_click`/`ui_scroll`; the helper
maps them and repeats foreground, target identity, hit-test, held-modifier and actual-cursor
checks. Moved/resized/DPI-changed/minimized targets or stale IDs are refused; observe again.
No coordinate input is available with screenshots disabled; ref-based scrolling remains available.

Density is the count of readable non-Window UIA rows not flagged offscreen in the bounded
snapshot; unknown visibility counts. It is a heuristic, not screen-area coverage or proof of
complete accessibility. At the threshold, the summary is included; below it, no tree refs are
exposed or accepted. Traversal limits can underestimate density. Dense summaries retain bounded
names, IDs, flags and values with the existing password-value protections. Refresh observations
after UI changes; the image is captured before tree traversal, not atomically with the tree.

## Perception and performance

For large apps, prefer `ui_find` or `ui_tree` with a `root` ref over a full deep tree.
`root` must come from the latest snapshot of that window; depth and node limits start at that
element. A subtree observation still captures the **whole target window**, not just the element,
and uses the same screenshot privacy/visibility rules. Density omission also applies to subtrees;
disable screenshots explicitly if you need sparse tree-only refs. `ui_find` never captures an image
or omits sparse matches. It walks at most **3000 visited nodes**, to depth **30**, with a cooperative
**20 s** budget, stopping at `maxResults`; the ancestor path shows up to three names/roles within
the searched subtree. A cut result is not proof that no further matches exist.

Reads use UIA2 `CacheRequest` batches per parent's `FindAll(Children, TrueCondition)`, never one
whole-tree `Subtree` fetch. The root gets its own `GetUpdatedCache`. The cache uses
`AutomationElementMode.Full` so refs remain actionable, `TreeScope.Element`, and an explicit
`TrueCondition` **raw-view TreeFilter** to preserve the old child set (the default ControlView
filter would change it). Only control type, name, automation ID, enabled/offscreen/password
flags, pattern-availability flags and non-secret toggle state are cached. **Value, IsReadOnly and
text are never cached.** Those current per-element reads remain budget-guarded and password-gated:
password controls never query values/text, and unknown-password Edit/Document nodes fail closed.
Cache failures fall back to current reads for that node, not the whole tree. A failed root cache
refresh must not reuse metadata from the previous snapshot, including its password flag.

The footer reports milliseconds, returned nodes and characters, `cached=<n> fallback=<n>`, and
`retried=true|false`; search also reports visited nodes. Cache/fallback counters describe read
attempts, not a promise of native speed. Root ancestry validation and Chromium retry validation
share the 20 s budget, with deadline checks between ancestry calls; screenshot capture time is
excluded. A single synchronous provider call can still overrun the budget. Real-provider
performance and behavior need manual Windows verification.

### Virtualized lists and waiting

With a `root` container that supports ItemContainerPattern, `ui_find` also uses
`FindItemByProperty` for a supplied name or automation ID, iterating with `startAfter` up to
`maxResults`. **Only exact API property matches can find unrealized items**; ordinary realized
subtree matches still use case-insensitive substrings and all filters combine with AND. Matching
items get refs in the same snapshot and `virtualized=true` when they support VirtualizedItemPattern.
The read never calls Realize and consumes each placeholder before the next lookup can invalidate it.
The exact lookup establishes its selected Name/AutomationId predicate even when that getter is
unavailable; additional filters still require readable matching properties.

Use `ui_scroll` with `ref` and `into: true` to realize a virtualized item (which may itself scroll
the list), then call ScrollItemPattern.ScrollIntoView when supported. The result lists the steps
that ran and the containing ScrollPattern's `verticalPercent` when available. Unrealized refs
revalidate their source container and reacquire a fresh item on the bounded worker only when a
captured runtime ID establishes identity. Without a runtime ID, the action is refused with an
instruction to run `ui_find` again and act on the fresh ref; even a unique Name/AutomationId match
cannot authorize substituting another element. A fresh ref still needs verifiable identity.
Additional filters are checked again, and realized items must pass the normal window ancestry
check before further scrolling.
Without either pattern, the action is refused; it never falls back to the mouse.
Ref/delta searches no more than five parent levels, never outside the target window, and refuses
non-vertically-scrollable containers. Pattern dispatch uses the existing background worker and
five-second wait. A provider already executing an action may continue after that wait; timeout
is not rollback. Only vertical small-step scrolling is supported, not horizontal or absolute-position scrolling.

`ui_wait` polls every 250 ms outside the serialized helper. Without element filters it checks
visible top-level windows using the same case-insensitive substring filter as `ui_windows`
(title, handle, process, PID and class). A handle targets that exact top-level window. With element
filters it searches the target window using `ui_find` matching, without realizing virtualized items.
Each poll shares a 1000-node budget across all candidate windows, including failed searches, and
has a short cooperative deadline. Incomplete enumeration or an unreadable search cannot prove
that an element is gone. `ui_windows.cut` includes display-only title truncation; its separate
`incomplete` flag identifies unfinished enumeration. Shortened titles alone do not prevent a gone wait. Large/sparse/provider-limited trees may time out even when
the desired condition is true. A synchronous provider call can overrun a poll budget; the overall
wait deadline retires a blocked helper without latching the action stop. Cancellation, emergency
stop and session teardown interrupt both polling and sleep promptly. A successful element exists
wait replaces that window's refs and screenshot ID; window-only/gone/unsuccessful waits do not
publish new refs. Read waits remain available while stopped and never resume actions.

### Chromium and Electron

Windows with classes starting `Chrome_WidgetWin_` sometimes populate accessibility only after
the first UIA query. If the bounded snapshot has fewer readable on-screen elements than
`treeDensityThreshold`, wait **500 ms** and traverse once more, within the same 20 s budget.
The footer reports `retried=true` when the second traversal runs. Search checks the density of
visited nodes, not the number of matches. If it remains sparse, the result explains that the app
looks Chromium/Electron-based and exposes little UI Automation.

Relaunching with `ui_launch` and the argument **`--force-renderer-accessibility`** usually fixes
this. **This restarts the app and can lose unsaved work; never relaunch without the user's
request.** The extension never changes or relaunches an already-running app to enable accessibility,
and does not use CDP or remote debugging. Retrying is read-only and does not focus the app.

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
operations never reposition your real cursor. Ref-based `ui_scroll` also leaves the real pointer
in place; it does not use wheel input or require screenshot coordinates.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `ui_windows` | optional `filter` | Up to 200 visible top-level `windows`: native handle (`window`), title (120 characters), process name, PID, class, physical bounds, minimized/foreground state. Case-insensitive substring across these identifiers; a `cut` flag/note reports truncated output. |
| `ui_tree` | `window`, optional `root` ref, `depth` (8, 0–30), `maxNodes` (300, 1–1000) | Whole-target PNG ImageBlock, screenshot ID, physical bounds, image size, DPI and axis scales; dense UIA summary starting at `root` with fresh refs, password flags and traversal footer |
| `ui_find` | `window`, at least one of `name`, `role`, `automationId`; optional `root` ref, `maxResults` (20, 1–100) | Read-only UIA search, no screenshot; matching rows with fresh refs and up to 3 ancestor names/roles, plus traversal footer; exact ItemContainerPattern lookup can also return unrealized items marked `virtualized=true`. Filters combine with AND: name/automationId are case-insensitive substrings; role is a case-insensitive ControlType name without `ControlType.` (for example `Button`). |
| `ui_wait` | Either `window` or `title`; `until: "exists"` or `"gone"`; optional `name`, `role`, `automationId`, `timeoutMs` (5000, 100–30000) | Read-only polling without screenshots; `status: "met"` or `"timed-out"`, `elapsedMs`, and on exists a matching window handle or element row with a fresh ref. Uses ui_windows-style title filtering and ui_find-style element matching. |
| `ui_launch` | `command`, optional string-array `args`, `cwd` | New PID plus an unambiguous new window, or a PID and instruction to use `ui_windows` |
| `ui_click` | `window`, either `ref` or `screenshot`, `x`, `y` | UIA pattern/clickable-point input for refs, or guarded screenshot-space click; reports path |
| `ui_scroll` | `window`; either `screenshot`, `x`, `y`, `delta`; or `ref`, `delta`; or `ref`, `into: true` | Coordinates: guarded wheel input. Ref/delta: ScrollPattern on the element or nearest supporting ancestor (up to 5 parent levels), repeated small vertical steps. Ref/into: Realize when virtualized, then ScrollIntoView when supported. Reports `path: "scrollpattern"` or `"scrollitem"`, the steps that ran, and VerticalScrollPercent when available. Integer nonzero delta −10…10, positive up, negative down; forms cannot be mixed. Remains an action. |
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
child dialogs. Refresh with `ui_tree` or `ui_find` after UI changes. Handles may be recycled by
Windows; old refs are invalid after helper death, closing or a new snapshot. **There is one ref
generation per window:** every new `ui_tree`/`ui_find` or successful element `ui_wait` replaces all its refs, including the `root`
ref used for that request (the element gets a new ID if returned). These reads do not preserve refs
from the previous snapshot, and `ui_find` and successful element `ui_wait` also invalidate old screenshot IDs. Invalid/stale roots
require `ui_tree` **without root** to recover. Trees are bounded by node/depth
limits, a cooperative 20 s traversal budget and a 200,000-character TypeScript ceiling.
Unreadable nodes receive no actionable ref and do not prevent reading siblings. Text fields
are escaped onto one line and limited to 512 characters. `ui_type` accepts at most 20,000
UTF-16 code units. A single synchronous provider call can still exceed the traversal budget.

`ui_close` only requests WindowPattern.Close/WM_CLOSE and reports **closed or still open** after
its brief observation wait; a save prompt may remain. It **never force-kills**, even for an app
launched by this extension. Exact PID/creation-time kills of still-running launched processes are
reserved for **session cleanup** and the headless-member emergency-stop rule above.
There are no image-name kills.

`ui_close`, `ui_focus`, `ui_click`, `ui_scroll`, `ui_type` and `ui_key` refuse desktop/taskbar shell classes
(`Progman`, `WorkerW`, `Shell_TrayWnd`, `Shell_SecondaryTrayWnd`), the overlay's own native window,
and identifiable Amira console/terminal windows (Amira PID/ancestor identities and console HWND).
Reads can still list and inspect them. Terminal-host identification is best effort; native window
ownership varies between console hosts.

## Lifecycle

The helper and overlay start lazily through `api.openPipe`. A headless extension-owned lifetime
sentinel bridges host unload. A separate headless watchdog can clean up while UIA is blocked;
an **independent session-lifetime custody owner** retains cleanup-capable job duplicates across
watchdog crashes and replacements.
Exact launch PID/start-time records, the helper identity and opaque job IDs are atomically
journaled in `%TEMP%/amira-uia-<UUID>.json` (`OwnershipVersion=3`), with no titles, screen text
or action history. Every write carries an HMAC-SHA256 over the exact serialized content, including
a per-session nonce and the state path. A new random 32-byte key and nonce are generated with
each client session's state path; helper replacements reuse that session's credentials. Replacing
a lost watchdog starts a fresh state path/key/nonce generation, never adopting old jobs from the
journal; the independent custody owner keeps its already-retained kernel duplicates. The key
stays in memory and reaches the helper/watchdog only over stdin, never argv, environment or
files. Readers verify the MAC, nonce and path before trusting any identity. Untrusted records
are ignored with **“untrusted launch journal; cleanup refused”** and grant no cleanup authority;
they cannot block later launches. No other clients' journals are scanned. Reading, focusing,
clicking, or executable-matching a window never adds a launch record.

The watchdog creates an **unnamed, non-breakaway Windows job** before launch and transfers a
assignment-only job handle and a limited custody-owner parent-process handle only to the verified
helper PID/start-time identity.
The helper closes both duplicated handles when a requested transfer acknowledgement arrives late
or is rejected. Acknowledgements for job IDs this helper never requested are ignored without closing
any echoed handle numbers.

**Before launch handles are released or a root can run**, the watchdog pins a distinct cleanup
handle and offers it through the client's private pipes. Offers and acknowledgements bind the
custody session nonce, one-use transfer ID, job ID, source PID/creation time, pinned source handle,
and helper writer identity. The independent owner verifies those exact process identities and
pulls a new local `QUERY | TERMINATE` duplicate; it validates job/query rights before acknowledging.
Only an exact acknowledgement releases the source pin and permits launch. Unknown, mismatched,
replayed, or late transfers cannot grant launch authority or close arbitrary echoed handle numbers.
The custody protocol and native duplicates stay in memory/private stdin/stdout; journal PIDs or
handle numbers are never recovery authority.

The helper validates the parent's PID/creation time and assigns **both the job and the independent
custody owner as OS parent atomically** during suspended creation. Launched apps are children of
that session owner, not the transient helper or watchdog, so retiring either transient process
does not cascade a tree kill into apps. The session owner's tree remains attached to host shutdown.
No public job names or journal-supplied handles are opened. Closing job handles does not implicitly
kill apps: there is **no blanket kill-on-close**. Termination requires explicit cleanup through
retained handles in the watchdog or independent custody owner. After the helper journals the
suspended root, custody verifies its PID/creation time and membership through the retained job
handle and acknowledges its immutable root/grace metadata **before** the watchdog may resume it.
This preserves the three-second grace across watchdog loss without trusting journal PIDs.
The watchdog then verifies the exact identity and primary-thread ownership, registers and resumes it
before acknowledging the launch. Helper death cannot leave a registered root indefinitely suspended;
a lost acknowledgement does not authorize killing a launch the watchdog already committed.
Failure to retain/assign the job (including unsupported
nested jobs) refuses the launch instead of running it untracked. Tracked processes are the launched
process and **directly created process-tree descendants that remain in its job**, even if the
launcher exits. This does **not** track processes created by external brokers: WMI
`Win32_Process.Create`, `schtasks`/scheduled tasks, DCOM or explorer-mediated ShellExecute,
COM/ShellExecute to an existing instance, or services. Discovery never turns these into owned
processes. Emergency stop checks exact UTC FILETIME creation identities, job membership,
each member's own visible windows and the three-second root-start grace described above. Session end
terminates the whole job, polls for exit for two seconds, and retries once if incomplete.

Helper EOF, request timeout and helper restart **do not clean up launched apps**. Helpers are
retired through PID/creation-time-checked, non-tree termination; their pipe is closed only after
confirmed exit. If the watchdog dies, a headless exact-helper reaper is used, never a tree kill.
Retirement failure or a ten-second retirement timeout refuses replacement and reports the error
instead of hanging requests; session teardown still drains the watchdog and independent custody
owner, including trees retained before watchdog replacement.
After that exact old helper's native exit is confirmed, `/uia resume` followed by a tool request
(or the next read/start) can retry the retirement gate. Until exit is confirmed, replacement stays
refused; resume alone does not permit overlapping helpers.
The watchdog holds jobs across helper replacement; restarted helpers read only their own client's authenticated
journal and invalidate old window refs. Session end, host exit/unload,
**`/jobs stop` on the computer-use-uia lifetime job**, and **extension reload** end all launched
apps, including windowed apps with unsaved changes. Watchdog EOF drains that watchdog's retained
jobs; it does not discard the independent owner's authority over earlier generations. **Extension reload does not call the client's
`stop()` method**: cleanup relies on the extension-owned sentinel dying and the owners'
**three-second grace** before terminating retained jobs. The custody owner is not a descendant
of the transient watchdog, and watches the same exact sentinel identity plus its private-pipe EOF
or authenticated end request. On session end it retires the authenticated launch producers before draining **all** original
and replacement-generation jobs, preventing an in-flight launch from entering an apparently
empty job after cleanup. Stopping the lifetime sentinel signals both owners; the custody owner's
process tree also reaches its launches at host shutdown, while retained job handles cover
surviving descendants whose launcher has already exited. Failed producer retirement or a job-drain
failure keeps custody alive with its native handles and retries; a bounded client cleanup timeout
reports the failure without force-closing that owner. Replacement stays blocked until confirmed
cleanup. The watchdog pins the current helper identity over its private
client pipe, once per helper generation, checks the spawned child's PID and native creation time,
and acknowledges that identity before the helper's first journal write. Cleanup retires that exact
helper before verifying the final snapshot. Missing, stale or untrusted journals **never prevent
cleanup of jobs the watchdog itself retained**; journal-supplied identities grant no kill authority.
A complete session cleanup removes the journal and `.tmp`; unverifiable/incomplete cleanup retains
the journal and reports the failure. Existing windows are not closed during teardown.
Rotated journals are deleted after the old generation's cleanup finishes or its watchdog is
confirmed gone; cleanup authority remains in the independent owner's native duplicates, not
those files. Journals are kept only while they can provide evidence for active cleanup. A missing journal before the first write,
or a retired writer's snapshot before replacement writes, is not reported as incomplete when
all retained jobs were drained. On a non-force emergency stop, windowed members deliberately
preserved during a journal gap do not count as incomplete cleanup.
The overlay watches the exact helper and sentinel identities and exits on pipe EOF.
**Hard-killing only the watchdog does not immediately kill windowed apps.** Desktop actions
latch stopped, while the independent custody owner keeps the original jobs for session-end
cleanup. A replacement watchdog owns new launches without dropping those old duplicates.
Killing a transient watchdog's entire process tree does not end the independent custody owner
or its launched apps. If the independent custody owner itself is lost, the extension refuses further
launches and reports cleanup authority unavailable; it never guesses kernel objects or recovers ownership from PIDs.

Invoke/Toggle/SelectionItem/ExpandCollapse/SetValue, WindowPattern.Close and element SetFocus run
on background threads with a **five-second wait**. If a click/type provider remains busy, the
helper returns **“action timed out; it may still be running or the target may be busy — use
ui_windows”** and remains available to locate the dialog. Timeout cancels an action still in
preflight, so it cannot dispatch later; it cannot cancel or roll back a UIA call already entered.
A focus timeout refuses subsequent input. A bounded number of busy pattern calls is allowed;
additional calls are refused until one finishes.

### Emergency-stop asynchronous ordering audit

The relevant asynchronous boundaries, from interrupted launch through session end, are:

| Boundary | Completion/evidence and ordering rule |
| --- | --- |
| In-flight launch ownership/root handoff | Private custody-transfer, root-metadata and commit acknowledgements are bound to their session/job/helper generation. Late replies cannot resume a retired helper. A suspended member may exist before root metadata arrives. |
| Watchdog physical death → exit notification | The host notification may arrive before or after a stop/read/end request. It latches control, fails the interrupted tool request and starts exact-helper retirement. Retained native job handles do not depend on notification delivery. |
| Retirement dispatch | A live watchdog receives the exact helper identity; after watchdog loss a separate exact-identity reaper is dispatched. Dispatch is immediate, not delayed behind custody classification. |
| Exact helper exit and reaper/retire acknowledgement | These notifications may arrive in either order. Successful retirement requires the identity-bound exit evidence; failed attempts may recover only after the same exact exit is confirmed. Otherwise cleanup reports incomplete. |
| Overlay abort/input-release/exit, if enabled | Runs alongside retirement and is included in the retirement barrier. Replacement cannot overlap a retiring monitor; existing fake monitor-release/startup regressions cover this optional branch. |
| Watchdog's own stop drain acknowledgement or exit | Bound to the originating pipe, even if session end has already cleared the active watchdog. Custody waits for this checkpoint as well as helper retirement; an old exit cannot complete a replacement watchdog's stop. |
| Post-retirement custody request → scans → acknowledgement | Only after the preceding barriers does custody inspect all retained jobs using the unchanged cached-producer and identity/job/own-window checks. Incomplete results and unavailable/overdue confirmations are reported. Late acknowledgements remain usable. |
| A second stop during any wait/acknowledgement | Starts retirement immediately again and coalesces a burst into an additional pass. A request arriving during promise settlement is not dropped. Reads keep following queued passes until the live gates are clear. |
| Replacement request → watchdog readiness → helper identity/writer handshake → overlay readiness | A queued read first waits for retirement and all cleanup passes. Each subsequent startup checkpoint revalidates the generation/session-end state. A stop/end during readiness cannot launch an old queued action. |
| Session-end request | Can preempt any preceding boundary: retire the helper, close the watchdog input, signal custody end and stop the exact lifetime sentinel. An interrupted emergency pass must not claim success on unavailable evidence. |
| Custody producer retirement → whole-session job drain/retry → drained reply → owner exit | The independent owner ends all original/replacement job trees, including windowed members. Unconfirmed drainage retains authority and reports incomplete; client teardown waits for confirmations without force-closing the last owner. |

The fake table in `unit.test.ts` covers **4,320 scenarios**: all **240 causal orderings** of
watchdog-exit delivery, exact-helper exit, reaper reply, stop request, replacement request and
session-end request, crossed with reaper success/failure, immediate/either-delayed cleanup
acknowledgement, and ready/watchdog-blocked/helper-identity-blocked replacement startup. The
fallback reaper's exit/reply follow watchdog notification; all other caller/event orders are
permuted, including stop before watchdog-exit delivery. Internal handshakes keep the causal
ordering listed above rather than being independently reorderable.

Crucially, session-end drainage is held back in every row: **before** releasing it, every
custody pass must observe retired original producers, the eligible suspended member must be
gone **or an explicit incomplete-cleanup report must exist**, and the minimized member must
still be alive. Then session drainage must remove both. This prevents session teardown from
masking an emergency-stop survivor. Separate regressions cover immediate stop without yielding,
retry after failed retirement without a read, and a second stop/read while the first custody
acknowledgement is held. Pending/grace-protected jobs and windowed members remain intentionally
ineligible for emergency termination under the rules above.

These are fake/static checks, not proof of native Windows scheduling or process teardown.

## Limitations

- Requires Windows 10 version 1607 or later, and an active, connected, unlocked interactive desktop. Secure desktops,
  Session 0 and disconnected RDP sessions are unsupported.
- **Elevated windows are inaccessible from a non-elevated helper.** Do not use this to operate
  UAC/security prompts. UIA/input may fail across integrity levels.
- Chromium/Electron apps may remain sparse after the one-time retry; see the relaunch guidance
  above. Enabling renderer accessibility does not guarantee a complete or accurate tree.
- Games, canvas apps and custom-drawn controls often expose sparse or empty UIA trees. These
  use screenshot-space input; no OCR is provided. Providers can be stale, expensive or hang.
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
bun run typecheck
bun run lint
bun run test
```

`unit.test.ts` uses fake host/jobs/pipes for settings, tool traits, arbitrary handles/launches,
window-local refs, emergency-stop latching/explicit resume, startup-stop races, timeout aborts,
untrusted-result framing, model-facing stop notices and overlay protocol/lifecycle. U1 coverage adds
subtree/search validation, ref replacement, search readOnly/untrusted framing, cache/fallback footer
contracts and Chromium retry/hint source contracts. On Windows, `helper.test.ts` also runs an
**offline PowerShell stub harness** for ancestry deadlines: it extracts selected functions, uses a
fake clock/providers, and never executes helper startup or loads UIAutomationClient. This is
not native UIA/provider verification. U2 adds fake-clock wait deadlines, polling/cancellation/stop
and queued-startup regressions, scroll-form validation and virtualized refs. Its offline helper
harness compiles the bounded worker against inert UIA/native stand-ins to exercise scroll batches,
ancestor limits, Realize/ScrollIntoView ordering, exact container lookup and bounded presence polls.
It does not load real UIA or call desktop APIs.

The test script lists only fake/static suites explicitly, including density/omission,
ImageBlock shape, PNG scaling and coordinate/DPI math, settings validation, stop classification,
session teardown, and evaluation opt-in/metrics. It never imports the live desktop suite.
Source contracts do **not** prove C#/PowerShell execution, capture privacy, or native behavior.

Development setup: run `bun install --offline` (fall back to `bun install` on cache miss),
then `bun run link-amira D:/dev/Amira` (or your checkout's absolute path). Linking supplies host
packages, TypeScript and Biome; no host changes or settings edits are needed.

## Manual D113 regression evaluation

**Never run this on an in-use desktop.** `eval:desktop` is separate from `test` and CI. It refuses
to run before importing desktop services or launching anything unless `--allow-desktop` or
`AMIRA_UIA_EVAL=1` is explicit; it also refuses CI and non-Windows hosts. The bundled WinForms
fixture has its own opt-in gate. No user settings/auth files are read or written: evaluation
uses in-memory settings and a temporary directory, never `~/.amira`.

On an idle, unlocked dedicated Windows machine, configure a vision/tool-capable model through
explicit environment variables and run (PowerShell example):

```powershell
$env:AMIRA_UIA_EVAL_MODEL = 'your-model-id'
$env:AMIRA_UIA_EVAL_BASE_URL = 'https://your-provider.example/v1'
$env:AMIRA_UIA_EVAL_API_KEY = 'your-api-key'
bun run eval:desktop --allow-desktop
```

The bundled runner uses `@amira/ai` with explicit provider configuration, fresh history per
trial and the same model in both modes. `AMIRA_UIA_EVAL_MODEL` is the endpoint-native model ID,
not an Amira provider/model reference. Optional `AMIRA_UIA_EVAL_DIALECT` defaults to
`openai-chat`; `AMIRA_UIA_EVAL_MAX_TURNS` defaults to 40. For an intentionally unauthenticated
endpoint, set `AMIRA_UIA_EVAL_KEYLESS=1` and omit the API key (do not set both).
The runner offers only fixture-scoped extension tools and forwards complete image blocks. For another provider/session integration, pass
`--runner ./your-runner.ts`; that trusted module exports `createRunner(): EvalRunner`
(see `scripts/eval-desktop.ts`). Return `{ usage, error? }`: actual provider token counters or
`usage: null`, with an optional failure message. Never return text-length estimates or throw
away already measured usage when returning a failed outcome. Runner modules are trusted code,
not a security sandbox.

Six fixed tasks cover profile fields, Unicode text, checkboxes, priority choice, a two-click
counter and a gated release. Each gets a fresh uniquely titled owned form in both modes
(12 trials), with counterbalanced order. The form's own validation handler supplies an independent
success label. Tree-only uses `screenshot: false`; screenshot+tree uses `screenshot: true`;
both set `treeDensityThreshold: 0`, so the comparison isolates the addition of images. Defaults
are 40 attempted tool calls and 120 seconds per trial. Escape/hotkey stop remains enabled;
an emergency stop aborts the suite without automatic resume.

JSON stdout reports success rate, attempted tool-call steps (reads included), actual
input/output/cache token counters, and solver wall time per trial and mode. Setup, scoring and
teardown are excluded from solver time. Unknown token counts stay `null`, with measured-trial
coverage and a known subtotal; no invented token metric. Failed model trials retain counters
already measured when consumption is fully known; an interrupted/unreported request keeps total
usage unknown rather than presenting a partial count as complete. Verification exceptions become
failed/unscorable trial records, preserving completed trials and the affected trial's steps, usage
and solver time. Emergency stop still prevents any subsequent fixture launch.
No images or unrelated window titles
are saved by the harness. The model provider still receives fixture images/text. Results are
synthetic regression evidence, not a claim about arbitrary apps. This implementation has not
been live-evaluated; the maintainer must produce and review the first baseline by hand.

## Existing manual desktop tests

Desktop tests are **explicitly opt-in**. They explicitly disable screenshots to retain legacy
UIA/provider/input coverage; run the D113 evaluation and screenshot checklist separately.
Do not run them while anyone is using the machine. Importing/skipping `desktop.test.ts` starts no probes or processes. On a dedicated idle Windows
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
Loss of the helper and watchdog does not erase the independent owner's retained job authority:
session end still drains original and replacement trees. Native custody transfer, watchdog-loss
recovery and producer/drain races require manual Windows checks; fake tests do not prove them.
Do not use blanket `bun test` as a
substitute for the explicit fake-only paths on a live desktop.

### Maintainer acceptance checks (manual only)

Use disposable, uniquely titled test-owned windows on an idle Windows desktop. These checks
have **not** been run by the coding agent:

- Check stop classification with a visible parent, a visible/minimized `WS_EX_TOOLWINDOW` child,
  and a windowless sibling: keep both windowed processes, terminate only the windowless owned
  worker, leave a foreign test process alone, then end the session and verify the entire owned tree exits.
- After a launch is acknowledged, crash only its exact watchdog, resume into a replacement and
  launch another fixture. Emergency-stop first: windowless workers in **both generations** must
  exit while old/new windowed and minimized members survive. Then end the session and confirm
  all remaining owned processes exit, including descendants whose launcher already exited. Repeat through lifetime-sentinel stop/reload;
  custody acknowledgement failure must refuse a launch, not run an untracked process.
  Also interrupt before root registration and stop immediately, without yielding to exact-helper
  retirement. Cleanup must wait for confirmed retirement and then clean the abandoned member,
  or explicitly report incomplete. Repeat a stop before/after acknowledgement and after a failed
  retirement's late exact-exit confirmation; no intervening read should be needed to retry.
  A genuinely pending launch stays protected.
  Inject a worker during another worker's termination: follow-up scans must find it, while a
  continuously spawning chain must produce an incomplete result rather than false success.
- Simulate/delay the overlay's screenshot-hide acknowledgement. The observation must fail without
  a stop latch; the old overlay must exit and a new observation must recover with a fresh overlay.
  Repeat with the latch already set: recovery must work without clearing it or allowing actions.
  Actual hotkey/Escape stops must still latch normally.
- Run `eval:desktop` with its explicit opt-in and cause one scoring read to fail. Earlier trials
  and the affected trial's usage/steps/time must remain in the report. Emergency stop, including
  during cleanup, must return a partial aborted report without starting another fixture.
- Set a small model-turn budget and inspect failed-trial token counters. Also compare timeout
  during a measured-response tool call against timeout during an unreported model request:
  retain complete measured usage in the former; leave unknown total usage `null` in the latter.
- Run the opt-in desktop suite with a temporary directory containing an apostrophe and spaces;
  its windowed-child wrapper must pass the exact paths without PowerShell source interpolation.
- Compare cached reads against raw `FindAll(Children, TrueCondition)` on disposable UIA providers,
  including non-ControlView children, unsupported metadata and cache failures. Verify password and
  unknown-password Edit/Document values are never queried. Check subtree depth/node limits, whole-window
  screenshots, search filters/ancestor paths and ref replacement across tree/find; old root refs must fail.
  In a disposable Chromium/Electron app, verify the 500 ms sparse retry, shared budgets and advisory
  relaunch hint without any automatic restart. Measure native latency separately from fake contracts.
- Retest screenshot density/omission, image-space click/scroll, moved/stale/obscured targets,
  maximized frames and rounded corners on mixed-DPI/negative-coordinate monitors, including
  a DPI-unaware target at 300% scaling. Use dummy secrets only; images are not password-redacted.
