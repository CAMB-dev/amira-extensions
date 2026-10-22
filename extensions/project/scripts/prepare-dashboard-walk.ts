/** Build a self-contained trusted fixture for ui-walk --extension; no real home or Git. */
import { cp, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const directory = await mkdtemp(path.join(tmpdir(), "project-dashboard-walk-extension-"))
await cp(path.join(import.meta.dir, "../src"), path.join(directory, "src"), { recursive: true })
await writeFile(
  path.join(directory, "package.json"),
  JSON.stringify({
    name: "project-dashboard-walk-fixture",
    type: "module",
    amira: { engines: { amira: "^0.1.65" }, extensions: ["./fixture.ts"] },
  }),
)
await writeFile(
  path.join(directory, "fixture.ts"),
  `
import path from "node:path"
import { createProject, readProject, IterationStore } from "./src/store.ts"
import { createProjectExtension } from "./src/index.ts"
import { ProjectDashboards, projectSourceId } from "./src/dashboard.ts"
import { ProjectCosts } from "./src/cost.ts"
import { FileCostPersistence } from "./src/cost-storage.ts"
export default async (api) => {
  createProjectExtension()(api)
  const dashboards = new ProjectDashboards(api)
  api.onUnload(() => dashboards.dispose())
  api.onExit(() => dashboards.dispose())
  api.registerCommand({ name: "walk-project", description: "Seed a temporary read-only project dashboard", async run(_args, ctx) {
    const root = path.dirname(process.env.HOME)
    const relative = path.relative(root, api.cwd)
    if (relative.startsWith("..") || path.isAbsolute(relative) || !process.env.AMIRA_HOME?.startsWith(process.env.HOME)) throw new Error("Not an isolated UI-walk fixture")
    let project
    try { project = await readProject(api.cwd) } catch { project = await createProject(api.cwd, "Offline release demo", { language: "en" }) }
    await new IterationStore(project).read()
    const costs = new ProjectCosts(project.marker.id, new FileCostPersistence(project), { stop() {}, notify() {} })
    await costs.load(false, 1)
    await costs.intent("walk-design", { iteration: 1, stage: "design", role: "design research" })
    await costs.bind("walk-design", "walk-owned-design")
    const usage = (cost) => ({ knownCostUsd: cost, complete: true, usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost } })
    await costs.observe("walk-design", { sessionId: "walk-owned-design", revision: 1, own: usage(0.4), total: usage(1.2), descendants: [{ sessionId: "walk-research-child", parentSessionId: "walk-owned-design", groupId: "walk-research", usage: usage(0.8) }] })
    dashboards.track(project)
    await dashboards.refresh()
    ctx.print("Read-only fixture ready. /dashboard " + projectSourceId(project.marker.id))
  } })
}
`,
)
console.log(directory)
