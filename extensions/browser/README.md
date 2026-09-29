# browser

Browser tools for Amira: the model opens pages in a real Chromium (headless by default),
looks at them, clicks and types, reads their state and their console. Made for checking the
web app you are working on, on its dev server.

```sh
amira ext install browser
```

Needs Amira's extension API with `isPrivateAddress` (0.1.1 plus that addition), and a
Chromium-based browser. No browser is downloaded: the extension uses one that is installed,
looked for in this order:

1. `extensions.browser.executablePath` in `~/.amira/settings.json`;
2. Google Chrome, then Microsoft Edge (which comes with Windows), then Chromium, in their usual
   install places (on Linux, on `PATH`);
3. a Chromium that Playwright downloaded: `bunx playwright-core install chromium`.

It runs the browser itself, through Amira's `runCommand` (so its whole process tree is killed
with it), and drives it with [playwright-core](https://playwright.dev) over the DevTools
protocol.

## Tools

| Tool | What it does |
|---|---|
| `browser_open(url, waitUntil?)` | Opens a URL; returns the title, HTTP status, console errors and the start of the page's text. Starts the browser. |
| `browser_snapshot(selector?)` | The accessibility tree as YAML: the cheap way to see a page and find selectors |
| `browser_screenshot(selector?, fullPage?)` | A PNG of the viewport, the whole page (up to 8000px tall) or one element, sent to the model as an image |
| `browser_click(selector, button?, doubleClick?)` | Clicks, then reports where the page is and new console errors |
| `browser_type(selector, text, append?, submit?)` | Fills a field (or types after its content); `submit` presses Enter |
| `browser_select(selector, values)` | Chooses `<select>` options by value or label |
| `browser_eval(expression)` | Evaluates JavaScript in the page and returns JSON, cut at `maxEvalChars` |
| `browser_console(level?, limit?, clear?)` | Recent console messages, page errors, dialogs and refused requests |
| `browser_close()` | Closes the browser |

Only `browser_open` is offered to the model all the time; the others are deferred tools,
loaded as soon as a page is open (or through `tool_search`).

Selectors are Playwright's: CSS, `text=Sign in`, `role=button[name="Save"]`. When several
elements match, the first is used and the result says so.

`browser_eval` is meant for reading (counts, computed styles, storage, app state); nothing
stops an expression from changing the page, so the tool's description asks the model to use
the other tools for that. Models without image input get the screenshot's description only;
`browser_snapshot` is the better tool for them.

Dialogs (`alert`, `confirm`, `prompt`) are dismissed at once and logged. Downloads are
refused. Service workers are blocked, so every request goes through the checks below.

## One browser per session

Each session, and each sub-agent, gets its own browser with a fresh throwaway profile: no
cookies or storage carry over, and nothing of yours (bookmarks, logins) is visible. It
closes:

- after `idleMinutes` without a browser tool call (default 10);
- with `browser_close`;
- when its session or sub-agent ends, when `/clear` or `/resume` replaces the conversation,
  and when Amira exits.

The next `browser_open` starts a new one. While a browser is open, the status bar shows
`browser <host>` (or `browser ×2` for several).

## What pages may reach

- `http` and `https` URLs, including `localhost`, `*.localhost` and loopback addresses:
  dev servers are the point.
- Private-network addresses (10.x, 172.16–31.x, 192.168.x, link-local such as cloud metadata,
  and host names that resolve to them) are refused, for the page itself and for every
  request it makes, unless `allowPrivateNetwork` is set.
- `file://` URLs only with `allowFileUrls`.
- Other schemes (`chrome://`, `javascript:`, …) are never opened.

Refused requests show up in `browser_console` as `[blocked]`, and in the result of the call
that caused them.

The checks are best effort: redirects of subresources are not checked hop by hop, and a host
name is resolved again by the browser, so a name that changes its answer (DNS rebinding) can
get past them. The browser's DevTools port listens on 127.0.0.1 while it runs.

## Settings

In `settings.json`, under `extensions.browser`:

```jsonc
{
  "extensions": {
    "browser": {
      "headless": true,            // false shows the browser window
      "idleMinutes": 10,
      "viewport": { "width": 1280, "height": 800 },
      "maxEvalChars": 20000,
      "navigationTimeoutMs": 30000,
      "actionTimeoutMs": 10000,
      // Only read from ~/.amira/settings.json; a project file cannot set these:
      "executablePath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "allowFileUrls": false,
      "allowPrivateNetwork": false
    }
  }
}
```

## Tests

The tests start a real browser against a local test server, through Amira's `runCommand`,
so they need Amira's packages (and skip the browser tests when no browser is found):

```sh
bun install
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
