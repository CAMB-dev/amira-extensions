# mcp-server

Serves Amira as an [MCP](https://modelcontextprotocol.io) server over stdio, so other coding
agents can delegate work to it, for example to a cheaper model.

```sh
amira ext install mcp-server
amira mcp serve -m deepseek/deepseek-flash
```

In an MCP client's configuration:

```json
{
  "mcpServers": {
    "amira": { "command": "amira", "args": ["mcp", "serve", "-m", "deepseek/deepseek-flash"] }
  }
}
```

## Tool

`amira_run(prompt, model?, cwd?, sessionId?)` runs one prompt in an Amira session and
returns the final reply and the session id. Pass the session id back to continue the same
conversation. Each call is its own `amira -p --json` process, with your settings,
extensions and API keys; calls can run in parallel, and a cancelled call kills the whole
process tree. A relative `cwd` is taken from the server's default directory.

When the client closes stdin, the server stops reading and exits once the calls still
running have answered (each is bounded by `--timeout`); only `notifications/cancelled`
stops a call early.

Options of `amira mcp serve`:

| Option | Meaning |
|---|---|
| `-m, --model <ref>` | Default model (otherwise Amira's settings) |
| `-C, --cwd <dir>` | Default working directory (where it was started) |
| `--timeout <min>` | Longest one call may take (30) |

Not yet: choosing a sub-agent role (once Amira has roles), streaming progress
notifications, and exposing Amira's individual tools.
