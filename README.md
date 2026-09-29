# Amira extensions

Official, optional extensions for [Amira](https://github.com/CAMB-dev/Amira). What every
user needs ships with Amira itself; these are installed on demand, each from its directory
under [`extensions/`](extensions), and listed in [`index.json`](index.json).
`amira ext search` shows them, `amira ext list` what is installed, `amira ext update`
moves every installed one to its newest commit, and `--project` installs into
`<project>/.amira/packages` instead of your user directory.

| Extension | What it does | Install |
|---|---|---|
| [mcp-server](extensions/mcp-server/README.md) | Amira as an MCP server (`amira mcp serve`), so Claude Code, Codex, Gemini CLI and others can hand it tasks | `amira ext install mcp-server` |
| [workflow](extensions/workflow/README.md) | `/workflow` and a `workflow` tool: TypeScript scripts that orchestrate many sub-agents, with limits, a progress view and resume | `amira ext install workflow` |
| [swarm](extensions/swarm/README.md) | `/swarm <goal>`: long-lived agents that work on one goal together through a shared blackboard and messages | `amira ext install swarm` |
| [lsp](extensions/lsp/README.md) | Language server diagnostics: errors in the files the model just changed go back to it, plus a `diagnostics` tool and `/lsp` | `amira ext install lsp` |
| [checkpoints](extensions/checkpoints/README.md) | A snapshot of the files before each turn, in private git refs; `/rewind` restores files, or files and conversation | `amira ext install checkpoints` |
| [hooks](extensions/hooks/README.md) | Your commands on events: format or lint after each edit, block or ask before risky commands, tests after a turn | `amira ext install hooks` |
| [todo](extensions/todo/README.md) | `todo_write` and `todo_read`: the model's todo list for multi-step work, shown live above the activity line | `amira ext install todo` |
| [notify](extensions/notify/README.md) | Notifications when a long turn ends, a question waits or background agents finish: desktop (Windows, macOS, Linux) or webhooks (Telegram, Discord, WeCom, JSON) | `amira ext install notify` |
| [share](extensions/share/README.md) | `/export` the session as Markdown or self-contained HTML, secrets redacted; `/commit`, `/pr` and `/review` git helpers | `amira ext install share` |
| [browser](extensions/browser/README.md) | `browser_*` tools: the model opens pages (your dev server) in an installed Chrome or Edge, takes screenshots, clicks, types and reads the console | `amira ext install browser` |

<details>
<summary>The index, writing a package, and adding one here</summary>

### The index

`amira ext search` and `amira ext install <name>` read [`index.json`](index.json) from the
default branch of this repository (cached for an hour in `~/.amira/cache`, and used from
there when offline). Set `AMIRA_EXTENSIONS_INDEX` to a URL or a local file to use another
index.

```jsonc
{
  "schemaVersion": 1,
  "extensions": [
    {
      "name": "mcp-server",                 // what `amira ext install <name>` takes; must equal the package's name
      "description": "One line for search results",
      "version": "0.1.0",                   // informational; installs pin the real commit
      "source": {                           // one of:
        "git": "https://github.com/CAMB-dev/amira-extensions.git",
        "path": "extensions/mcp-server",    //   optional subdirectory of the repository
        "ref": "v0.1.0"                     //   optional branch, tag or commit (default: the default branch)
      },
      // "source": { "npm": "some-package@^1" }
      "engines": { "amira": "^0.1" },       // semver range of Amira's extension API
      "tags": ["mcp"],                      // searched along with name and description
      "homepage": "https://..."             // optional
    }
  ]
}
```

Unknown fields are ignored, so the format can grow; an entry that does not fit is skipped
with a warning rather than breaking the whole index. Entries may point at other
repositories or npm packages, not only at directories here.

### Writing a package

A package is a directory with a `package.json` (or an `amira-package.json`) whose `amira`
field says what it contributes:

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "module",
  "amira": {
    "engines": { "amira": "^0.1" },
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"],
    "commands": { "mytool": "./src/cli.ts" }
  }
}
```

- `extensions`: modules that default-export `(amira: ExtensionAPI) => void`, loaded after
  Amira's built-ins. Without the list, `index.ts` or `src/index.ts` is used.
- `skills`: directories of `SKILL.md` skills.
- `commands`: `amira <name> ...` runs the module's default export with a
  `PackageCommandContext` instead of starting a session.

`.ts` files load directly, without a build step. Import only from `@amira/api`, which
Amira provides at runtime; if you list it for type checking, put it under
`devDependencies`. Other `dependencies` are installed with `bun install --production`.

Installs record the exact commit (git) or version and integrity (npm) in
`~/.amira/packages.lock` or `<project>/.amira/packages.lock`. Commit the project lock
file: `amira ext install --project` with no arguments installs exactly what it pins. A
project package replaces a user package of the same name.

### Adding an extension here

One directory per extension under `extensions/`, with its own README, plus an entry in
`index.json` and a row in the table above. Keep extensions small, load nothing expensive at
startup, and start processes only through `runCommand` or `openPipe`.

</details>
