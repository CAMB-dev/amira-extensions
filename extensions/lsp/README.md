# lsp

Language server diagnostics for Amira: after the model edits or writes files, the language
server for each file checks it, and the errors it finds go back to the model with the tool
result, so it fixes them in its next step instead of finding out later.

```sh
amira ext install lsp
```

Needs Amira's extension API with `openPipe` and the `tool.result.after` interceptor.

## What the model sees

When a batch of edits and writes (one model reply) is done, the files it changed are checked
together, and the last call of the batch gets the findings appended:

```
LSP diagnostics: 2 errors
src/app.ts:14:7 error Type 'string' is not assignable to type 'number'. (2322)
src/util.ts:3:1 error Cannot find name 'foo'. (2304)
```

- One line per diagnostic, `file:line:col severity message (code)`, most severe first, at
  most `maxItems` (20) of them; the rest are counted.
- Only errors by default (`severity`); nothing is added when a file is clean, except after
  it had problems: then `src/app.ts: no problems now`.
- A failed edit changes nothing, so it adds no file, but the batch is still reported.
- Sub-agents' edits are checked the same way, in their own working directory.

The model also gets a `diagnostics` tool: errors and warnings (by default) for one file, e.g.
one it did not just change.

In the transcript the edit's result line gets the counts (`+3 −1 · 2 errors`) and the
diagnostics are listed above its diff. The status bar shows `lsp …` while a check runs, then
the problems in the files checked so far (`lsp 2 errors`) or `lsp ✓`.

`/lsp` lists the servers, which are installed, running (and for which folder) or failed, and
the problems found; `/lsp restart` stops them all (they start again with the next edit) and
looks for installed servers afresh.

## Servers

Nothing is installed for you: a server is used when its program is on `PATH` (on Windows,
`.cmd` launchers such as npm's count).

| Id | Files | Programs tried, in order |
|---|---|---|
| `typescript` | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `typescript-language-server --stdio`; without it, `tsc --noEmit` |
| `python` | `.py .pyi` | `pyright-langserver --stdio`, `basedpyright-langserver --stdio` |
| `rust` | `.rs` | `rust-analyzer` |
| `go` | `.go` | `gopls` |
| `csharp` | `.cs` | `csharp-ls`, `OmniSharp -lsp`, `omnisharp -lsp` |

A server starts the first time a file of its kind is checked, and keeps running until Amira
exits. Each runs for a project folder: the topmost folder between the file and the working
directory that has one of the server's markers (`tsconfig.json`, `package.json`,
`pyproject.toml`, `Cargo.toml`, `go.mod`, `*.sln`, ...), so a monorepo gets one server;
without a marker, the working directory. A server that fails to start is reported once and
left alone until `/lsp restart`; one that crashes is started again, up to three times.

The first check of a new server waits longer (4 × `waitMs`), since servers load the project
first. A server that does not answer in time adds nothing; the model can ask again with the
`diagnostics` tool.

Without `typescript-language-server`, TypeScript files are checked with the project's own
`tsc` (`node_modules/.bin`, else `PATH`): `tsc --noEmit -p` the nearest `tsconfig.json`. That
is slower (the whole project) and skips JavaScript.

## Settings

In `settings.json`, under `extensions.lsp`:

```jsonc
{
  "extensions": {
    "lsp": {
      "enabled": true,
      "severity": "error",          // least severe fed back: "error", "warning", "information", "hint"
      "maxItems": 20,               // diagnostic lines added to one result
      "waitMs": 4000,               // how long to wait for a server after an edit
      "startupTimeoutMs": 20000,    // how long a server may take to start
      "tscTimeoutMs": 60000,        // the tsc fallback
      "tools": ["edit", "write"],   // tools whose calls are checked
      "languages": ["typescript", "python"], // only these servers (default: all)
      "servers": {
        // Change a built-in one, field by field:
        "python": { "command": ["basedpyright-langserver", "--stdio"] },
        "rust": { "enabled": false },
        // Or add your own:
        "zig": {
          "command": ["zls"],
          "extensions": [".zig"],
          "rootMarkers": ["build.zig"],
          "languageId": "zig",
          "initializationOptions": {},
          "settings": {}            // answers workspace/configuration
        }
      }
    }
  }
}
```

A server entry of your own comes before the built-in ones, so it wins for the extensions it
lists. Setting `command` on the TypeScript server turns the `tsc` fallback off. Wrong values
are reported and replaced by their defaults.

## Tests

The tests run a fake language server over stdio and the extension on a real agent loop, so
they need Amira's packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
