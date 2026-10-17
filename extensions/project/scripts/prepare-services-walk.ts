/** Trusted offline ui-walk fixture. Never load it in a real home or project. */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const directory = await mkdtemp(path.join(tmpdir(), "project-services-walk-extension-"))
await cp(path.join(import.meta.dir, "../src"), path.join(directory, "src"), { recursive: true })
await mkdir(path.join(directory, "test"))
await cp(
  path.join(import.meta.dir, "../test/frontend-services-fixture.ts"),
  path.join(directory, "test/frontend-services-fixture.ts"),
)
await writeFile(
  path.join(directory, "package.json"),
  JSON.stringify({
    name: "project-services-walk-fixture",
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
import { workflowFixture } from "./test/frontend-services-fixture.ts"

// Only explicit local Git probes bypass ui-walk's inert shell tool overrides.
async function local(command, cwd) {
  const root = path.dirname(process.env.HOME)
  const relative = path.relative(root, cwd)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture cwd outside isolated UI-walk root")
  if (!command.includes("git ")) throw new Error("Only local Git fixture commands are allowed")
  const git = Bun.which("git")
  const shell = process.platform === "win32" ? [path.resolve(path.dirname(git), "../bin/bash.exe"), path.resolve(path.dirname(git), "../../usr/bin/bash.exe"), path.resolve(path.dirname(git), "../usr/bin/bash.exe")].find(existsSync) : "bash"
  const child = Bun.spawn([shell, "-c", command], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { content: [{ type: "text", text: (out + err).trimEnd() }], details: { exitCode }, isError: exitCode !== 0 }
}
export default (api) => {
  workflowFixture("ui-walk/implementer").extension(api)
  api.registerCommand({ name: "walk-prepare", description: "Initialize only the temporary offline repository", async run(_args, ctx) {
    const result = await local('git init && git config user.name "Services UI Walk Fixture" && git config user.email "services-walk@invalid.local" && git config commit.gpgsign false && git add -A && git commit -m "Offline services baseline"', api.cwd)
    ctx.print(result.isError ? JSON.stringify(result) : "Offline temporary Git fixture ready; workflow.runner is a mock service using real owned children.")
  } })
  const conversations = { ...api.conversations, async openOrCreate(spec, runtime) {
    const handle = await api.conversations.openOrCreate(spec, runtime)
    return new Proxy(handle, { get(target, key) {
      if (key === "runTool") return (name, args) => local(String(args.command), target.cwd)
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
