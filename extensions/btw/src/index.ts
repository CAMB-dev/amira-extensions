import type { CommandContext, Extension, ToolLine, ViewDefinition } from "@amira/api"
import { buildContext } from "./context.ts"

const SYSTEM =
  "Answer the user's side question briefly using the conversation so far; you cannot use tools or change anything."
const HISTORY_LIMIT = 5
const ANSWER_LINES = 8

interface Answer {
  question: string
  text: string
}

interface State {
  current?: Answer
  visible: boolean
  history: Answer[]
  pending?: AbortController
}

interface ViewData {
  title: string
  answers: Answer[]
}

const view: ViewDefinition<ViewData> = {
  kind: "btw",
  title: (data) => data.title,
  follow: false,
  render: (data) =>
    data.answers.flatMap((answer): ToolLine[] => [
      { kind: "accent", text: `btw: ${answer.question}` },
      ...answer.text.split("\n").map((text): ToolLine => ({ kind: "text", text })),
      { kind: "text", text: "" },
    ]),
}

const extension: Extension = (api) => {
  const states = new Map<string, State>()

  function cancel(state: State) {
    if (state.pending && state.current) state.current.text = "Cancelled."
    state.pending?.abort()
    state.pending = undefined
  }

  function hide(sessionId: string) {
    const state = states.get(sessionId)
    if (!state) return
    state.visible = false
    api.requestRender()
  }

  api.registerView(view)
  api.registerPanel({
    id: "btw",
    render({ sessionId, collapsed }) {
      const state = states.get(sessionId)
      if (!state?.visible || !state.current) return []
      const lines: ToolLine[] = [{ kind: "accent", text: `btw: ${state.current.question}` }]
      if (collapsed) return lines
      lines.push(
        ...state.current.text
          .split("\n")
          .slice(0, ANSWER_LINES)
          .map(
            (text): ToolLine => ({
              kind: state.pending ? "muted" : "text",
              text,
            }),
          ),
      )
      lines.push({ kind: "muted", text: "/btw show · /btw history · /btw clear" })
      return lines
    },
  })

  async function ask(question: string, ctx: CommandContext, state: State) {
    cancel(state)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ctx.signal])
    const answer: Answer = { question, text: "thinking…" }
    state.pending = controller
    state.current = answer
    state.visible = ctx.frontend === "tui"
    api.requestRender()
    try {
      signal.throwIfAborted()
      const setting = api.settings.extensions?.btw?.model
      const model = typeof setting === "string" ? setting.trim() : ""
      const context = buildContext(ctx.session.messages())
      const result = await api.complete({
        system: SYSTEM,
        ...(model ? { model } : {}),
        messages: [
          ...(context
            ? [
                {
                  role: "user" as const,
                  content: [
                    { type: "text" as const, text: `Conversation so far (context only):\n\n${context}` },
                  ],
                },
              ]
            : []),
          { role: "user", content: [{ type: "text", text: question }] },
        ],
        label: "btw",
        signal,
      })
      if (signal.aborted || state.pending !== controller) return
      answer.text = result.text || "No answer returned. Try /btw with another question."
      state.history.push({ ...answer })
      if (state.history.length > HISTORY_LIMIT) state.history.shift()
      if (ctx.frontend !== "tui") ctx.print(answer.text)
    } catch (error) {
      if (signal.aborted || state.pending !== controller) return
      answer.text = `Could not answer: ${error instanceof Error ? error.message : String(error)}\nTry /btw again.`
      if (ctx.frontend !== "tui") ctx.print(answer.text, "error")
    } finally {
      if (state.pending === controller) {
        state.pending = undefined
        if (signal.aborted) {
          answer.text = "Cancelled."
          state.visible = false
        }
        api.requestRender()
      }
    }
  }

  function show(ctx: CommandContext, title: string, answers: Answer[]) {
    if (ctx.frontend === "tui") {
      // Do not fall back to printing: that would disturb the main transcript.
      ctx.openView?.({ kind: "btw", data: { title, answers } satisfies ViewData })
    } else {
      ctx.print(answers.map((answer) => `btw: ${answer.question}\n${answer.text}`).join("\n\n"))
    }
  }

  api.registerCommand({
    name: "btw",
    description: "Ask a side question without interrupting the main agent",
    args: { hint: "<question> | clear | show | history" },
    // A side question leaves no line in the transcript (Amira API 0.1.26).
    echo: false,
    run(args, ctx) {
      const id = ctx.session.info().id
      let state = states.get(id)
      if (!state) {
        state = { visible: false, history: [] }
        states.set(id, state)
      }
      const question = args.trim()
      if (question === "clear") {
        cancel(state)
        hide(id)
      } else if (question === "show" || question === "history") {
        const answers = question === "history" ? [...state.history] : state.current ? [state.current] : []
        show(
          ctx,
          question === "history" ? "btw history" : "btw",
          answers.length
            ? answers
            : [
                {
                  question: "Ask a side question",
                  text: "No answers yet. Use /btw <question>.",
                },
              ],
        )
      } else if (!question) {
        show(ctx, "btw", [
          {
            question: "Ask a side question",
            text: "Use /btw <question>, /btw show, /btw history or /btw clear.",
          },
        ])
      } else {
        // TUI and RPC dispatch commands concurrently; awaiting preserves host command cancellation.
        return ask(question, ctx, state)
      }
    },
  })

  api.on("turn.start", (event) => hide(event.sessionId))
  api.on("turn.steer", (event) => {
    if (event.data.state === "queued" && !event.data.message.display?.origin) hide(event.sessionId)
  })
  api.on("session.end", (event) => {
    const state = states.get(event.sessionId)
    if (state) cancel(state)
    states.delete(event.sessionId)
    api.requestRender()
  })
}

export default extension
