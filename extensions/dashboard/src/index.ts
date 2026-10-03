import { defineExtension, type SessionControl } from "@amira/api"
import { createLiveSource } from "./live.ts"
import type { DashboardSource, DashboardSources } from "./source.ts"
import { createTraceSource } from "./trace.ts"
import { dashboardView, VIEW_KIND } from "./view.ts"

export type * from "./source.ts"

/** Registration identity guards stale disposers; duplicate IDs fail rather than silently replace. */
export function sourceRegistry(changed: () => void) {
  const sources = new Map<string, DashboardSource>()
  const disposers = new Map<string, () => void>()
  const registrations = new Map<string, symbol>()
  const service: DashboardSources = {
    register(source) {
      if (!/^[a-z][\w.-]*$/i.test(source.id) || ["agents", "trace"].includes(source.id)) {
        throw new Error(`Invalid or reserved dashboard source ID: ${source.id}`)
      }
      if (sources.has(source.id)) throw new Error(`Dashboard source already registered: ${source.id}`)
      const unsubscribe = source.subscribe?.(changed)
      const registration = Symbol(source.id)
      registrations.set(source.id, registration)
      sources.set(source.id, source)
      const dispose = () => {
        if (registrations.get(source.id) !== registration) return
        registrations.delete(source.id)
        sources.delete(source.id)
        disposers.delete(source.id)
        unsubscribe?.()
        changed()
      }
      disposers.set(source.id, dispose)
      changed()
      return dispose
    },
  }
  return {
    sources,
    registrations,
    service,
    dispose: () => {
      for (const dispose of [...disposers.values()]) dispose()
    },
  }
}

export default defineExtension((api) => {
  const registry = sourceRegistry(() => api.requestRender())
  let live: ReturnType<typeof createLiveSource> | undefined
  let owner: string | undefined
  let generation = 0
  const liveFor = (session: SessionControl) => {
    if (!live || owner !== session.info().id) {
      live?.dispose()
      live = createLiveSource(session, api)
      owner = session.info().id
    }
    return live
  }
  const initial = api.session()
  if (initial) liveFor(initial)
  api.on("session.start", (event) => {
    if (event.parentSessionId) return
    const session = api.session()
    if (session && session.info().id === event.sessionId) liveFor(session)
  })
  api.on("session.end", (event) => {
    if (event.sessionId !== owner || event.data.reason !== "switch") return
    live?.dispose()
    live = undefined
    owner = undefined
  })
  api.onExit(() => {
    live?.dispose()
    registry.dispose()
  })
  api.provideService("dashboard.sources", registry.service)
  api.registerView(dashboardView)
  api.registerCommand({
    name: "dashboard",
    description: "Open the agent timeline or replay recorded trace statistics",
    args: {
      hint: "[agents|trace|source-id]",
      complete: () => [
        { value: "agents", description: "Live sub-agents" },
        { value: "trace", description: "Completed trace records for this session and its children" },
        ...[...registry.sources.values()].map((source) => ({ value: source.id, description: source.label })),
      ],
    },
    async run(args, ctx) {
      const request = ++generation
      if (ctx.signal.aborted) return
      if (!ctx.openView) {
        ctx.print("The dashboard needs a frontend with full-screen views.", "warning")
        return
      }
      const id = args.trim() || "agents"
      const source =
        id === "agents"
          ? liveFor(ctx.session)
          : id === "trace"
            ? await createTraceSource(ctx.session, ctx.signal)
            : registry.sources.get(id)
      if (ctx.signal.aborted || request !== generation) return
      if (!source) {
        ctx.print(`Unknown dashboard source: ${id}. Use /dashboard agents or /dashboard trace.`, "warning")
        return
      }
      // A removed provider must not remain actionable in a view that outlives its registration.
      const registration = registry.registrations.get(id)
      const registered = () => registry.registrations.get(id) === registration
      const guarded: DashboardSource = registration
        ? {
            id: source.id,
            label: source.label,
            snapshot: () =>
              registered()
                ? source.snapshot()
                : {
                    workspace: ctx.cwd,
                    phases: [],
                    note: "This dashboard source was unregistered. Reopen /dashboard to choose another source.",
                  },
            details: (agentId) => (registered() ? source.details(agentId) : undefined),
            act: (agentId, action, text) =>
              registered() && source.act
                ? source.act(agentId, action, text)
                : "This dashboard source is no longer available.",
          }
        : source
      if (!ctx.openView({ kind: VIEW_KIND, data: { source: guarded } })) {
        ctx.print("The dashboard could not open. Close the current dialog and try again.", "warning")
      }
    },
  })
})
