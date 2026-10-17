/** Disposable screenshot fixture. Never installs into the real Amira home.
 * Reuses the implementation walk's isolated Git/child adapter, then aliases the
 * acceptance observation tool to ui-walk's allowed agent protocol. This is only
 * a presenter walkthrough; frontend-accept.test.ts exercises the unadapted tool.
 */
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "prepare-implement-walk.ts")], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
})
const [output, error, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
])
if (exitCode !== 0) throw new Error(error)
const directory = output.trim()
const file = path.join(directory, "fixture.ts")
let fixture = await readFile(file, "utf8")
const replacements = [
  [
    '    const implementation = spec.descendants === "inherit"',
    '    const implementation = spec.descendants === "inherit"\n    const acceptance = spec.key.includes("/accept/")',
  ],
  [
    "    const handle = await api.conversations.openOrCreate(adapted, callbacks)",
    `    const reviewSpec = acceptance ? { ...adapted, callableTools: adapted.callableTools.map((name) => name === "project_record_acceptance" ? "agent" : name), systemPrompt: adapted.systemPrompt.replaceAll("project_record_acceptance", "agent") } : adapted
    const reviewRuntime = acceptance ? { ...callbacks, extraTools: callbacks.extraTools.map((tool) => ({ ...tool, name: "agent", parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, tasks: { type: "array", maxItems: 0 } }, required: ["items", "tasks"] }, execute: (args, ctx) => tool.execute({ items: args.items }, ctx) })) } : callbacks
    const handle = await api.conversations.openOrCreate(reviewSpec, reviewRuntime)
    let fixtureToolRan = false`,
  ],
  [
    '      if (key === "runTool") return (name, args) => local(String(args.command), target.cwd)',
    `      // Local fixture tools do not drive the native owned handle's stopped -> idle transition.
      if (key === "runTool") return async (name, args) => { fixtureToolRan = true; return local(String(args.command), target.cwd) }
      if (key === "stop") return async (reason) => { fixtureToolRan = false; return target.stop(reason) }
      if (key === "status") return () => {
        const status = target.status()
        return fixtureToolRan && status.state === "stopped" ? { ...status, state: "idle" } : status
      }`,
  ],
  [
    '      if (key === "send") return (text, options) => target.send(text.replaceAll("project_implement", "agent"), options)',
    '      if (key === "send") return (text, options) => target.send(text.replaceAll("project_implement", "agent").replaceAll("project_record_acceptance", "agent"), options)',
  ],
  [
    '    if (key === "conversations") return conversations',
    `    if (key === "settings") return { ...api.settings, declare(schema) {
      const settings = api.settings.declare(schema)
      return { ...settings, get: () => ({ ...settings.get(), reviewerModel: "ui-walk/reviewer" }) }
    } }
    if (key === "conversations") return conversations`,
  ],
] as const
for (const [before, after] of replacements) {
  if (!fixture.includes(before)) throw new Error(`Implementation fixture adapter changed: ${before}`)
  fixture = fixture.replace(before, after)
}
await writeFile(file, fixture)
console.log(directory)
