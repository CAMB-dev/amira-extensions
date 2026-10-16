/** Create a disposable UI-walk fixture; never install it in a real Amira home.
 * Actual policy/tool/child execution is covered by frontend-implement.test.ts.
 * UI-walk blocks arbitrary tools, so this fixture supplies local Git runTool
 * results and aliases the fixed spawn tool to its whitelisted agent protocol.
 */
import { cp, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const directory = await mkdtemp(path.join(tmpdir(), "project-implement-walk-extension-"))
await cp(path.join(import.meta.dir, "../src"), path.join(directory, "src"), { recursive: true })
await writeFile(
  path.join(directory, "package.json"),
  JSON.stringify({
    name: "project-implement-walk-fixture",
    type: "module",
    amira: { engines: { amira: "^0.1.53" }, extensions: ["./fixture.ts"] },
  }),
)
await writeFile(
  path.join(directory, "fixture.ts"),
  `
import path from "node:path"
import { existsSync } from "node:fs"
import { createProjectExtension } from "./src/index.ts"

// Trusted OFFLINE FIXTURE ONLY: subprocesses use the ui-walk temporary home/cwd.
async function local(command, cwd) {
  const home = path.dirname(process.env.HOME)
  const relative = path.relative(home, cwd)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture cwd outside isolated UI-walk root")
  const git = Bun.which("git")
  const shell = process.platform === "win32" ? [path.resolve(path.dirname(git), "../bin/bash.exe"), path.resolve(path.dirname(git), "../../usr/bin/bash.exe"), path.resolve(path.dirname(git), "../usr/bin/bash.exe")].find(existsSync) : "bash"
  const child = Bun.spawn([shell, "-c", command], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { content: [{ type: "text", text: (out + err).trimEnd() }], details: { exitCode }, isError: exitCode !== 0 }
}
export default (api) => {
  api.registerCommand({ name: "walk-prepare", description: "OFFLINE FIXTURE: initialize the temporary repository", async run(_args, ctx) {
    const result = await local('git init && git config user.name "UI Walk Fixture" && git config user.email "walk@invalid.local" && git config commit.gpgsign false && git add -A && git commit -m "Offline fixture base"', api.cwd)
    ctx.print(result.isError ? JSON.stringify(result) : "Offline temporary Git fixture ready; Git checks in this walkthrough are fixture-adapted.")
  } })
  const conversations = { ...api.conversations, async openOrCreate(spec, runtime) {
    const implementation = spec.descendants === "inherit"
    const adapted = implementation ? { ...spec, model: "ui-walk/coordinator", callableTools: spec.callableTools.map((name) => name === "project_implement" ? "agent" : name), systemPrompt: spec.systemPrompt.replaceAll("project_implement", "agent") } : spec
    const callbacks = implementation ? { ...runtime, extraTools: runtime.extraTools.map((tool) => ({ ...tool, name: "agent", parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { isolation: { type: "string" }, model: { type: "string" } } } } }, additionalProperties: false } })) } : runtime
    const handle = await api.conversations.openOrCreate(adapted, callbacks)
    return new Proxy(handle, { get(target, key) {
      if (key === "createGroup") return (options) => {
        const group = target.createGroup(options)
        return new Proxy(group, { get(owner, field) {
          if (field === "spawn") return (task) => owner.spawn({ ...task, model: "ui-walk/implementer" })
          const value = Reflect.get(owner, field, owner)
          return typeof value === "function" ? value.bind(owner) : value
        } })
      }
      if (key === "runTool") return (name, args) => local(String(args.command), target.cwd)
      if (key === "send") return (text, options) => target.send(text.replaceAll("project_implement", "agent"), options)
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
  }, open: api.conversations.open.bind(api.conversations) }
  createProjectExtension()(new Proxy(api, { get(target, key) {
    if (key === "conversations") return conversations
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } }))
}
`,
)
console.log(directory)
