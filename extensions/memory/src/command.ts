import type { CommandContext } from "@amira/api"
import { checkName, MemoryError, type Scope, scopeOf } from "./format.ts"
import { type MemoryStore, requireMain, safeError } from "./store.ts"

export type Stores = Record<Scope, MemoryStore>
export type MemoryCommandContext = Pick<CommandContext, "frontend" | "signal" | "ui" | "print">

const HELP = `Memory commands:
/memory list [--scope global|project]
/memory show <name> [--scope global|project]
/memory edit <name> [--scope global|project]
/memory rm <name> [--scope global|project] [--yes]
/memory path
Named commands default to project. List shows both scopes. Names in different scopes are independent.`

export async function runMemoryCommand(
  args: string,
  ctx: MemoryCommandContext,
  stores: () => Promise<Stores>,
  depth: number | undefined,
  notify: (text: string) => void,
): Promise<void> {
  try {
    const words = args.trim().split(/\s+/).filter(Boolean)
    const verb = words.shift() ?? "list"
    if (verb === "help" && !words.length) {
      ctx.print(HELP)
      return
    }
    let scope: Scope | undefined
    let yes = false
    const positional: string[] = []
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      if (word === "--scope" && !scope) scope = scopeOf(words[++i])
      else if (word === "--yes" && !yes) yes = true
      else if (word.startsWith("--")) throw new MemoryError(HELP)
      else positional.push(word)
    }
    if (!["list", "show", "edit", "rm", "path"].includes(verb)) throw new MemoryError(HELP)
    const named = ["show", "edit", "rm"].includes(verb)
    if (positional.length !== (named ? 1 : 0) || (yes && verb !== "rm") || (scope && verb === "path")) {
      throw new MemoryError(HELP)
    }
    if (named) checkName(positional[0])
    // Even command invocation must fail before a store is opened for an unknown/child session.
    if (verb === "rm") requireMain(depth)
    const dirs = await stores()
    if (verb === "path") {
      ctx.print(`Global: ${dirs.global.dir}\nProject: ${dirs.project.dir}`)
      return
    }
    if (verb === "list") {
      for (const current of scope ? [scope] : (["global", "project"] as const)) {
        const snapshot = await dirs[current].snapshot()
        ctx.print(
          `${current}: ${dirs[current].dir}\n${snapshot.memories.length ? snapshot.index : "No memories saved."}${snapshot.invalid ? "\nInvalid memory files were omitted. Inspect this directory to repair them." : ""}`,
        )
      }
      return
    }
    const current = scope ?? "project"
    const store = dirs[current]
    const name = positional[0]!
    if (verb === "rm") {
      if (ctx.frontend === "tui") {
        if (
          (await ctx.ui.confirm("Delete memory?", `Delete ${name} (${current})? This cannot be undone.`, {
            signal: ctx.signal,
          })) !== true
        )
          return
      } else if (!yes) {
        throw new MemoryError("Use --yes to delete this memory in print or RPC mode.")
      }
      await store.delete(name, depth, ctx.signal)
      const message = `Forgot: ${name} (${current})`
      notify(message)
      ctx.print(message)
    } else if (verb === "edit") {
      // No terminal handoff/editor API exists. Do not spawn an editor behind the TUI.
      ctx.print(
        `${store.file(name)}\nEdit this file in your editor. Keep the name equal to the filename and retain valid metadata. Reads rebuild the index in memory; the next saved change refreshes MEMORY.md on disk.`,
      )
    } else {
      ctx.print((await store.read(name)).text)
    }
  } catch (error) {
    ctx.print(safeError(error), "error")
  }
}
