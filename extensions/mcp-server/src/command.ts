import path from "node:path"
import { parseArgs } from "node:util"
import type { PackageCommandContext } from "@amira/api"
import pkg from "../package.json" with { type: "json" }
import { amiraRunTool } from "./amira-run.ts"
import { serve } from "./server.ts"

const USAGE = `Usage: amira mcp serve [options]

Serves Amira as an MCP server on stdin and stdout, with one tool, amira_run,
so other coding agents can hand tasks to Amira.

Options:
  -m, --model <ref>     Default model for amira_run (else Amira's settings)
  -C, --cwd <dir>       Default working directory (default: where it starts)
      --timeout <min>   Longest a single amira_run may take (default 30)

Example MCP client entry:
  {"command": "amira", "args": ["mcp", "serve", "-m", "deepseek/deepseek-flash"]}`

/** `amira mcp ...`, provided through this package's "commands" (D48). */
export default async function mcp(ctx: PackageCommandContext): Promise<number> {
  const [sub, ...rest] = ctx.argv
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    ctx.stdout(`${USAGE}\n`)
    return sub === undefined ? 2 : 0
  }
  if (sub !== "serve") {
    ctx.stderr(`amira mcp: unknown command "${sub}"\n\n${USAGE}\n`)
    return 2
  }
  let values: { model?: string; cwd?: string; timeout?: string }
  try {
    values = parseArgs({
      args: rest,
      options: {
        model: { type: "string", short: "m" },
        cwd: { type: "string", short: "C" },
        timeout: { type: "string" },
      },
    }).values
  } catch (err) {
    ctx.stderr(`amira mcp: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    return 2
  }
  const minutes = values.timeout === undefined ? 30 : Number(values.timeout)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    ctx.stderr("amira mcp: --timeout must be a positive number of minutes\n")
    return 2
  }
  const defaults = {
    cwd: path.resolve(ctx.cwd, values.cwd ?? "."),
    timeoutMs: minutes * 60_000,
    ...(values.model ? { model: values.model } : {}),
  }
  await serve({
    name: "amira",
    version: pkg.version,
    tools: [amiraRunTool(ctx, defaults)],
    input: ctx.stdin,
    // Every stdout line is protocol; everything else goes to stderr.
    write: (line) => ctx.stdout(`${line}\n`),
  })
  return 0
}
