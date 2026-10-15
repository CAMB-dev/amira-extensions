// Resolve and load host code only after offline.ts has isolated homes, cwd and network.
import { type HostModule, hostDescribe, loadHostModule, requireHostModule } from "./amira-source.ts"

type WaitFor = (check: () => boolean, what: string, timeoutMs?: number) => Promise<void>
interface TestTerminal {
  write(data: string): void
  send(data: string): void
}
interface TestScreen {
  lines: string[]
  scrollback: string[]
  write(data: string): void
}
interface FrontendHost {
  ai: typeof import("@amira/ai")
  core: typeof import("@amira/core")
  app: { runInteractive(options: Record<string, unknown>): Promise<number> }
  files: { fileList(list: () => Promise<string[]>): unknown }
  harness: { noProbe(): Promise<unknown>; paste(text: string): string; waitFor: WaitFor }
  kit: { FakeTerminal: new (cols: number, rows: number) => TestTerminal }
  screen: { VirtualScreen: new (cols: number, rows: number) => TestScreen }
  extension: typeof import("../src/index.ts")
  store: typeof import("../src/store.ts")
}

async function loadFrontend(): Promise<HostModule<FrontendHost>> {
  const [ai, core, app, files, harness, kit, screen] = await Promise.all([
    loadHostModule<FrontendHost["ai"]>("packages/ai/src/index.ts", ["createAi", "createMockDialect"]),
    loadHostModule<FrontendHost["core"]>("packages/core/src/index.ts", [
      "Agent",
      "AgentTree",
      "CommandHost",
      "EventBus",
      "ExtensionHost",
      "InterceptorRegistry",
      "SessionStore",
      "ToolRegistry",
    ]),
    loadHostModule<FrontendHost["app"]>("packages/tui/src/app.ts", ["runInteractive"]),
    loadHostModule<FrontendHost["files"]>("packages/tui/src/file-index.ts", ["fileList"]),
    loadHostModule<FrontendHost["harness"]>("packages/tui/test/app-harness.ts", [
      "noProbe",
      "paste",
      "waitFor",
    ]),
    loadHostModule<FrontendHost["kit"]>("packages/tui-kit/src/index.ts", ["FakeTerminal"]),
    loadHostModule<FrontendHost["screen"]>("packages/tui-kit/test/screen.ts", ["VirtualScreen"]),
  ])
  const missing = [ai, core, app, files, harness, kit, screen].find((entry) => entry.module === undefined)
  if (missing) return { reason: missing.reason! }
  // A source override need not imply that this extension's development links exist.
  try {
    await import("@amira/api")
  } catch {
    return {
      reason:
        "The extension's @amira/api development link is unavailable. Run bun run link-amira <checkout>.",
    }
  }
  // Do not turn extension import/programming errors into a misleading host-availability skip.
  const [extension, store] = await Promise.all([import("../src/index.ts"), import("../src/store.ts")])
  return {
    module: {
      ai: requireHostModule(ai),
      core: requireHostModule(core),
      app: requireHostModule(app),
      files: requireHostModule(files),
      harness: requireHostModule(harness),
      kit: requireHostModule(kit),
      screen: requireHostModule(screen),
      extension,
      store,
    },
  }
}

const frontendHost = await loadFrontend()
export const requireFrontendHost = () => requireHostModule(frontendHost)
export const waitFor: WaitFor = (check, what, timeoutMs) =>
  requireFrontendHost().harness.waitFor(check, what, timeoutMs)
export function frontendSuite(name: string, register: () => void): void {
  hostDescribe(name, frontendHost, register)
}
