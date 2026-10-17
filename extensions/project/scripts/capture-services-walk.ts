/** bun scripts/capture-services-walk.ts <Amira checkout> <output directory>
 * Real fullscreen ui-walk, offline provider + explicit mock workflow service, 120x36.
 */
import { rm } from "node:fs/promises"
import path from "node:path"

const source = process.argv[2] ?? process.env.AMIRA_SOURCE
const output = process.argv[3]
if (!source || !output)
  throw new Error("usage: bun scripts/capture-services-walk.ts <Amira checkout> <output directory>")
const walk = path.resolve(source, "scripts/ui-walk/walk.ts")
const scenario = path.resolve(import.meta.dir, "../test/walk-services-scenario.json")
const name = `project-services-${process.pid}-${Date.now()}`
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${args.join(" ")}\n${stdout}\n${stderr}`)
  return stdout.trim()
}
const fixture = await run([path.join(import.meta.dir, "prepare-services-walk.ts")])
const command = (...args: string[]) => run([walk, args[0]!, name, ...args.slice(1)])
const keys = (...args: string[]) => command("keys", ...args)
const wait = (text: string) => command("wait", "--text", text, "--timeout", "120000")
try {
  console.log(
    await command(
      "start",
      "--cols",
      "120",
      "--rows",
      "36",
      "--scenario",
      scenario,
      "--extension",
      fixture,
      "--",
      "--fullscreen",
      "--permission-mode",
      "auto",
    ),
  )
  await wait("ui-walk/main")
  await keys("text:/project new Services --language en", "enter")
  await wait("Attached project Services")
  await keys("text:/walk-prepare", "enter")
  await wait("Offline temporary Git fixture ready")
  await keys("text:/project spec", "enter")
  await wait("Choose execution mode")
  console.log(await command("shot", path.resolve(output, "mode-choice-120x36.png")))
  await keys("down", "enter")
  await wait("Review implementation spec")
  await keys("enter")
  await wait("implementation")
  await keys("text:/project implement", "enter")
  await wait("Use committed base")
  await keys("down", "enter")
  await wait("workflow · Implement")
  await wait("S1: working")
  // Progress can arrive before the slash command has returned and refreshed stage chrome.
  for (let attempt = 0; ; attempt++) {
    const screen = await command("text")
    if (!screen.includes("/project…")) break
    if (attempt === 100) throw new Error(`Implementation command did not settle:\n${screen}`)
    await Bun.sleep(100)
  }
  console.log(await command("shot", path.resolve(output, "workflow-batch-in-progress-120x36.png")))
  console.log(await command("text"))
} finally {
  console.log(await command("stop"))
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
