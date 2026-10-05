import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { UiApi } from "@amira/api"
import { type MemoryCommandContext, runMemoryCommand } from "../src/command.ts"
import { MemoryStore } from "../src/store.ts"
import { fact, sandbox, signal } from "./helpers.ts"

function context(frontend: MemoryCommandContext["frontend"] = "rpc", answer: boolean | undefined = true) {
  const outputs: Array<{ text: string; level?: string }> = []
  const confirmations: string[] = []
  const ctx: MemoryCommandContext = {
    frontend,
    signal: signal(),
    print: (text, level) => {
      outputs.push({ text, level })
    },
    ui: {
      confirm: async (title: string) => {
        confirmations.push(title)
        return answer
      },
    } as unknown as UiApi,
  }
  return { ctx, outputs, confirmations, text: () => outputs.map((o) => o.text).join("\n") }
}

test("all command subcommands, explicit scopes, defaults and invalid syntax", async () => {
  const h = sandbox()
  try {
    const stores = {
      global: new MemoryStore(h.dataDir, "global", "test"),
      project: new MemoryStore(h.dataDir, "project", "test"),
    }
    const notices: string[] = []
    const run = async (args: string) => {
      const output = context()
      await runMemoryCommand(
        args,
        output.ctx,
        async () => stores,
        0,
        (text) => notices.push(text),
      )
      return output
    }
    expect((await run("")).text()).toContain("No memories saved")
    expect(existsSync(stores.global.dir)).toBe(false)
    await stores.global.write(fact(), 0, signal())
    await stores.project.write({ ...fact(), body: "Project-specific preference." }, 0, signal())
    const list = (await run("list")).text()
    expect(list).toContain("global:")
    expect(list).toContain("project:")
    expect((await run("list --scope global")).text()).not.toContain("project:")
    expect((await run("show writing-style")).text()).toContain("Project-specific preference")
    expect((await run("show writing-style --scope global")).text()).toContain("concrete examples")
    expect((await run("edit writing-style")).text()).toContain(stores.project.file("writing-style"))
    expect((await run("edit writing-style --scope global")).text()).toContain(
      stores.global.file("writing-style"),
    )
    const paths = (await run("path")).text()
    expect(paths).toContain(stores.global.dir)
    expect(paths).toContain(stores.project.dir)
    expect((await run("help")).text()).toContain("Memory commands:")
    for (const args of [
      "unknown",
      "show",
      "show ../escape",
      "path --yes",
      "list extra",
      "rm writing-style --no",
      "show writing-style --scope other",
      "list --scope",
      "list --scope global --scope project",
      "path --scope global",
    ]) {
      expect((await run(args)).outputs.at(-1)?.level).toBe("error")
    }
    expect((await run("rm writing-style")).text()).toContain("Use --yes")
    expect(existsSync(stores.project.file("writing-style"))).toBe(true)
    expect((await run("rm writing-style --yes")).text()).toContain("Forgot: writing-style (project)")
    expect(existsSync(stores.project.file("writing-style"))).toBe(false)
    expect(existsSync(stores.global.file("writing-style"))).toBe(true)
    await run("rm writing-style --scope global --yes")
    expect(notices).toEqual(["Forgot: writing-style (project)", "Forgot: writing-style (global)"])
    expect((await run("show missing")).text()).toContain("Memory not found")
  } finally {
    h.cleanup()
  }
})

test("TUI requires confirmation; print/RPC require --yes; child deletion fails before stores", async () => {
  const h = sandbox()
  try {
    const stores = {
      global: new MemoryStore(h.dataDir, "global", "test"),
      project: new MemoryStore(h.dataDir, "project", "test"),
    }
    await stores.project.write(fact(), 0, signal())
    for (const answer of [false, undefined]) {
      const output = context("tui", answer)
      // Avoid the helper's default for an explicitly unavailable dialog.
      if (answer === undefined) output.ctx.ui.confirm = async () => undefined
      await runMemoryCommand(
        "rm writing-style --yes",
        output.ctx,
        async () => stores,
        0,
        () => {},
      )
      expect(existsSync(stores.project.file("writing-style"))).toBe(true)
    }
    const print = context("print")
    await runMemoryCommand(
      "rm writing-style",
      print.ctx,
      async () => stores,
      0,
      () => {},
    )
    expect(print.text()).toContain("Use --yes")
    const child = context()
    await runMemoryCommand(
      "rm writing-style --yes",
      child.ctx,
      async () => {
        throw new Error("Must not open storage")
      },
      1,
      () => {},
    )
    expect(child.text()).toContain("Subagents are read-only")
    const tui = context("tui")
    await runMemoryCommand(
      "rm writing-style",
      tui.ctx,
      async () => stores,
      0,
      () => {},
    )
    expect(tui.confirmations).toEqual(["Delete memory?"])
    expect(existsSync(stores.project.file("writing-style"))).toBe(false)
    await stores.project.write(fact(), 0, signal())
    await runMemoryCommand(
      "rm writing-style --yes",
      print.ctx,
      async () => stores,
      0,
      () => {},
    )
    expect(existsSync(stores.project.file("writing-style"))).toBe(false)
  } finally {
    h.cleanup()
  }
})
