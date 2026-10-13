import type {
  ChildSession,
  CommandContext,
  Extension,
  SpawnGroup,
  UiControl,
  ViewDefinition,
  ViewLine,
} from "@amira/api"

const SYSTEM =
  "Answer this side question briefly using the forked conversation. You may read files, but must not change files or the main conversation."
const RETRY = "Close the dock with Esc or /btw clear, then ask again."

type Entry = { kind: "question" | "reply" | "error" | "note"; text: string }

interface Side {
  sessionId: string
  question: string
  entries: Entry[]
  child?: ChildSession
  group?: SpawnGroup
  control?: UiControl
  print: CommandContext["print"]
  status: string
  closed: boolean
  failure?: string
}

function details(side: Side): string {
  return side.entries
    .filter((entry) => entry.text)
    .map((entry) => {
      const label = { question: "Question", reply: "Answer", error: "Error", note: "Status" }[entry.kind]
      return `**${label}**\n\n${entry.text}`
    })
    .join("\n\n")
}

const extension: Extension = (api) => {
  // A reload must replace the old viewer, not reuse its data and stale lifecycle callbacks.
  const viewKind = `btw:${crypto.randomUUID()}`
  const sides = new Map<string, Side>()

  function finish(side: Side, persist = true) {
    if (side.closed) return
    side.closed = true
    if (sides.get(side.sessionId) === side) sides.delete(side.sessionId)
    if (side.child && side.child.state !== "ended" && side.child.state !== "idle") {
      side.entries.push({ kind: "note", text: "Stopped before the answer finished." })
    }
    side.child?.abort("btw dock closed")
    side.group?.end("btw dock closed")
    if (persist) {
      side.print(`btw: ${side.question}`, "info", {
        details: details(side),
        markdown: true,
        persist: true,
      })
    }
    api.requestRender()
  }

  function close(side: Side) {
    side.control?.close()
    // onClose normally finishes it; also handle a view that has not mounted yet.
    finish(side)
  }

  function fail(side: Side, error: unknown) {
    if (side.closed) return
    const message = error instanceof Error ? error.message : String(error)
    if (side.failure !== message) {
      side.entries.push({ kind: "error", text: `Could not answer: ${message}\n${RETRY}` })
      side.failure = message
    }
    side.status = "failed"
    api.requestRender()
  }

  const view: ViewDefinition<Side> = {
    kind: viewKind,
    title: (side) => `btw: ${side.question}`,
    titleAside: (side) => side.status,
    follow: true,
    hostKeys: "minimal",
    onOpen(side, control) {
      side.control = control
      if (side.closed) control.close()
    },
    onClose: (side) => finish(side),
    render: (side, opts) => {
      const lines = side.entries.flatMap((entry): ViewLine[] => {
        if (entry.kind === "question") return [{ kind: "user-message", text: entry.text }]
        if (entry.kind === "reply") {
          return opts.renderReply?.(entry.text) ?? [{ kind: "text", text: entry.text }]
        }
        return [{ kind: entry.kind === "error" ? "error" : "muted", text: entry.text }]
      })
      if (side.status === "waiting" || side.status === "working") {
        lines.push({
          kind: "muted",
          text: side.status === "waiting" ? "Waiting for an agent slot…" : "Thinking…",
        })
      }
      return lines
    },
  }
  api.registerView(view)

  async function watch(side: Side, child: ChildSession) {
    let reply: Entry | undefined
    try {
      for await (const event of child.events) {
        if (side.closed) return
        if (event.type === "subagent.state" && event.data.childSessionId === child.id) {
          // Results settle independently of this stream; queued states may already be stale.
          if (child.state !== "ended" && !side.failure) {
            side.status = { queued: "waiting", working: "working", idle: "ready", paused: "paused" }[
              event.data.state
            ]
          }
        } else if (event.sessionId === child.id) {
          if (event.type === "message.start") reply = undefined
          if (event.type === "message.delta" && event.data.kind === "text") {
            if (!reply) {
              reply = { kind: "reply", text: "" }
              side.entries.push(reply)
            }
            reply.text += event.data.text
          }
          if (event.type === "message.end") {
            const text = event.data.message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
            if (reply) reply.text = text
            else if (text) side.entries.push({ kind: "reply", text })
            reply = undefined
          }
          if (event.type === "turn.end" && event.data.reason === "error") {
            fail(side, event.data.error ?? "The side agent's turn failed.")
          }
          if (event.type === "events.lost") {
            throw new Error("The side answer stream lost events.")
          }
        }
        api.requestRender()
      }
    } catch (error) {
      fail(side, error)
      child.abort("btw stream failed")
      side.group?.end("btw stream failed")
    }
  }

  async function ended(side: Side, child: ChildSession) {
    const result = await child.result()
    if (side.closed) return
    if (result.status === "error") fail(side, result.error ?? "The side agent failed.")
    else if (!side.failure) {
      side.status = "ended"
      side.entries.push({ kind: "note", text: `Side agent ended. ${RETRY}` })
    }
    if (result.undelivered?.length) {
      side.entries.push({
        kind: "error",
        text: `${result.undelivered.length} follow-up message(s) did not reach the side agent.`,
      })
    }
    side.group?.end("btw agent ended")
    api.requestRender()
  }

  api.registerCommand({
    name: "btw",
    description: "Ask a side question without interrupting the main agent",
    args: { hint: "<question> | clear" },
    echo: false,
    run(args, ctx) {
      ctx.signal.throwIfAborted()
      const question = args.trim()
      const id = ctx.session.info().id
      let side = sides.get(id)
      if (question === "clear") {
        if (side) close(side)
        // A callback from an older instance may already have marked this side closed.
        sides.delete(id)
        return
      }
      if (!question) {
        ctx.print("Use /btw <question> to ask or follow up; Esc or /btw clear closes the dock.")
        return
      }
      if (side && (side.closed || !side.child || side.child.state === "ended")) {
        close(side)
        sides.delete(id)
        side = undefined
      }
      if (side) {
        side.entries.push({ kind: "question", text: question })
        try {
          if (!side.child?.send(question)) {
            fail(side, "The side agent is no longer accepting follow-ups.")
          } else {
            side.status = side.child.state === "queued" ? "waiting" : "working"
          }
        } catch (error) {
          fail(side, error)
        }
        api.requestRender()
        return
      }
      if (!ctx.openView || !ctx.session.createGroup) {
        throw new Error("Side questions need a TUI dock and an agent tree.")
      }
      const next: Side = {
        sessionId: id,
        question,
        entries: [{ kind: "question", text: question }],
        print: ctx.print,
        status: "working",
        closed: false,
      }
      sides.set(id, next)
      try {
        if (!ctx.openView({ kind: viewKind, data: next, placement: "dock" })) {
          finish(next, false)
          throw new Error("The btw dock cannot open now. Close the active form or view and try again.")
        }
      } catch (error) {
        finish(next, false)
        throw error
      }
      if (next.closed) return
      try {
        const setting = api.settings.extensions?.btw?.model
        const model = typeof setting === "string" ? setting.trim() : ""
        next.group = ctx.session.createGroup({ name: "btw" })
        next.child = next.group.spawn({
          // The host persists this title as side_usage.label; never derive it from the question.
          title: "btw",
          prompt: question,
          context: "fork",
          ephemeral: true,
          // Leave tools/excludeTools unset: inherit the parent's local declarations and order.
          callableTools: ["read", "grep", "glob"],
          ...(model ? { model } : {}),
          systemPrompt: SYSTEM,
        })
        next.status = next.child.state === "queued" ? "waiting" : "working"
        // Subscribe now; neither the command nor the input waits for the child's turn.
        void watch(next, next.child)
        void ended(next, next.child)
      } catch (error) {
        next.group?.end("btw spawn failed")
        fail(next, error)
      }
      api.requestRender()
    },
  })

  api.on("session.end", (event) => {
    const side = sides.get(event.sessionId)
    if (side) close(side)
  })
}

export default extension
