import { defineExtension } from "@amira/api"
import { createLiveSource } from "./live.ts"
import { agentsOf, type DashboardSource, type DashboardSources } from "./source.ts"
import { createTraceSource } from "./trace.ts"
import { type DashboardViewData, dashboardView, VIEW_KIND } from "./view.ts"

export type * from "./source.ts"

/** Registration identity guards stale disposers; duplicate IDs fail rather than silently replace. */
export function sourceRegistry(changed: () => void) {
  const sources = new Map<string, DashboardSource>()
  const disposers = new Map<string, () => void>()
  const registrations = new Map<string, symbol>()
  const subscriptions = new Map<string, Set<() => void>>()
  let closed = false
  const service: DashboardSources = {
    capabilities: { cards: true },
    register(source) {
      if (closed) throw new Error("Dashboard source registry is closed.")
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
        const errors: unknown[] = []
        for (const unsubscribe of [...(subscriptions.get(source.id) ?? [])]) {
          try {
            unsubscribe()
          } catch (error) {
            errors.push(error)
          }
        }
        subscriptions.delete(source.id)
        try {
          changed()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length) throw new AggregateError(errors, "Dashboard source unsubscribe failed.")
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
      if (closed || !registrations.has(id)) return () => {}
      const source = sources.get(id)
      const registration = registrations.get(id)
      const listeners = subscriptions.get(id) ?? new Set<() => void>()
      let active = true
      let unsubscribe: (() => void) | undefined
      const release = () => {
        if (!active) return
        active = false
        listeners.delete(release)
        unsubscribe?.()
      }
      listeners.add(release)
      subscriptions.set(id, listeners)
      try {
        const dispose = source?.subscribe?.(() => {
          if (active && !closed && registrations.get(id) === registration) changed()
        })
        // A synchronous provider callback may close or unregister during subscription.
        if (active) unsubscribe = dispose
        else dispose?.()
        if (closed || registrations.get(id) !== registration) release()
      } catch (error) {
        release()
        throw error
      }
      return release
    },
    dispose: () => {
      if (closed) return
      closed = true
      const errors: unknown[] = []
      for (const dispose of [...disposers.values()]) {
        try {
          dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Dashboard source unsubscribe failed during disposal.")
    },
  }
}

export default defineExtension((api) => {
  let active: DashboardViewData | undefined
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let closed = false
  const liveSources = new WeakMap<DashboardSource, { sessionId: string; dispose: () => void }>()
  const registry = sourceRegistry(() => {
    if (active) api.requestRender()
  })
  const close = () => {
    const previous = active
    active = undefined
    const release = unsubscribe
    unsubscribe = undefined
    try {
      release?.()
    } finally {
      if (previous) liveSources.get(previous.source)?.dispose()
    }
  }
  const open = (data: DashboardViewData) => {
    if (closed) return
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
  const dispose = () => {
    if (closed) return
    closed = true
    generation++
    try {
      close()
    } finally {
      registry.dispose()
    }
  }
  api.onExit(dispose)
  api.onUnload?.(dispose)
  api.provideService("dashboard.sources", registry.service)
  api.registerView({
    ...dashboardView,
    onOpen(data, view) {
      if (closed) return
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
      if (closed || ctx.signal.aborted) return
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
      if (closed || ctx.signal.aborted || request !== generation) {
        live?.dispose()
        return
      }
      if (!source) {
        ctx.print(`Unknown dashboard source: ${id}. Use /dashboard agents or /dashboard trace.`, "warning")
        return
      }
      // A removed provider must not remain actionable in a view that outlives its registration.
      const registration = registry.registrations.get(id)
      const registered = () => !closed && registry.registrations.get(id) === registration
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
            details: (agentId, opts) => (registered() ? source.details(agentId, opts) : undefined),
            subscribe: (changed) => (registered() ? registry.subscribe(id, changed) : () => {}),
            act: (agentId, action, text) => {
              if (!registered() || !source.act) return "This dashboard source is no longer available."
              if (agentsOf(source.snapshot()).find((agent) => agent.id === agentId)?.card?.kind === "stage")
                return "This stage is read-only. Use the source's commands to continue."
              return source.act(agentId, action, text)
            },
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
