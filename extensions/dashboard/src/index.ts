import { defineExtension } from "@amira/api"
import { createLiveSource } from "./live.ts"
import type { DashboardSource, DashboardSources } from "./source.ts"
import { createTraceSource } from "./trace.ts"
import { type DashboardViewData, dashboardView, VIEW_KIND } from "./view.ts"

export type * from "./source.ts"

/** Registration identity guards stale disposers; duplicate IDs fail rather than silently replace. */
export function sourceRegistry(changed: () => void) {
  const sources = new Map<string, DashboardSource>()
  const disposers = new Map<string, () => void>()
  const registrations = new Map<string, symbol>()
  const subscriptions = new Map<string, Set<() => void>>()
  const service: DashboardSources = {
    register(source) {
      if (!/^[a-z][\w.-]*$/i.test(source.id) || ["agents", "trace"].includes(source.id)) {
        throw new Error(`Invalid or reserved dashboard source ID: ${source.id}`)
      }
      if (sources.has(source.id)) throw new Error(`Dashboard source already registered: ${source.id}`)
      const registration = Symbol(source.id)
      registrations.set(source.id, registration)
      sources.set(source.id, source)
      const dispose = () => {
        if (registrations.get(source.id) !== registration) return
        registrations.delete(source.id)
        sources.delete(source.id)
        disposers.delete(source.id)
        for (const unsubscribe of [...(subscriptions.get(source.id) ?? [])]) unsubscribe()
        subscriptions.delete(source.id)
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
    subscribe(id: string, changed: () => void) {
      const source = sources.get(id)
      const registration = registrations.get(id)
      const listeners = subscriptions.get(id) ?? new Set<() => void>()
      let active = true
      const unsubscribe = source?.subscribe?.(() => {
        if (active && registrations.get(id) === registration) changed()
      })
      const release = () => {
        if (!active) return
        active = false
        listeners.delete(release)
        unsubscribe?.()
      }
      listeners.add(release)
      subscriptions.set(id, listeners)
      return release
    },
    dispose: () => {
      for (const dispose of [...disposers.values()]) dispose()
    },
  }
}

export default defineExtension((api) => {
  let active: DashboardViewData | undefined
  let unsubscribe: (() => void) | undefined
  let generation = 0
  const liveSources = new WeakMap<DashboardSource, { sessionId: string; dispose: () => void }>()
  const registry = sourceRegistry(() => {
    if (active) api.requestRender()
  })
  const close = () => {
    const previous = active
    active = undefined
    const release = unsubscribe
    unsubscribe = undefined
    release?.()
    if (previous) liveSources.get(previous.source)?.dispose()
  }
  const open = (data: DashboardViewData) => {
    if (active?.source === data.source) {
      // Replacing view data must not interrupt the live source's event cache.
      active = data
      return
    }
    close()
    active = data
    unsubscribe = data.source.subscribe?.(() => {
      if (active?.source === data.source) api.requestRender()
    })
  }
  api.onExit(() => {
    close()
    registry.dispose()
  })
  api.provideService("dashboard.sources", registry.service)
  api.registerView({
    ...dashboardView,
    onOpen(data, view) {
      open(data)
      dashboardView.onOpen?.(data, view)
    },
    onClose(data) {
      close()
      dashboardView.onClose?.(data)
    },
  })
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
      const sessionId = ctx.session.info().id
      const current = active?.source
      const live =
        id === "agents" && (!current || liveSources.get(current)?.sessionId !== sessionId)
          ? createLiveSource(ctx.session, api)
          : undefined
      const source =
        id === "agents"
          ? (live ?? current)
          : id === "trace"
            ? await createTraceSource(ctx.session, ctx.signal)
            : registry.sources.get(id)
      if (ctx.signal.aborted || request !== generation) {
        live?.dispose()
        return
      }
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
            subscribe: (changed) => (registered() ? registry.subscribe(id, changed) : () => {}),
            act: (agentId, action, text) =>
              registered() && source.act
                ? source.act(agentId, action, text)
                : "This dashboard source is no longer available.",
          }
        : source
      const data: DashboardViewData = { source: guarded, session: ctx.session }
      if (live) liveSources.set(live, { sessionId, dispose: () => live.dispose() })
      if (!ctx.openView({ kind: VIEW_KIND, data })) {
        live?.dispose()
        ctx.print("The dashboard could not open. Close the current dialog and try again.", "warning")
      } else if (active) {
        // Same-kind replacement does not call onOpen: switch subscriptions only after success.
        open(data)
      }
    },
  })
})
