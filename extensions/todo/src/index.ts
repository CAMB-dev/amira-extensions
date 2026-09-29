import type {
  Extension,
  ExtensionAPI,
  SessionData,
  ToolCallView,
  ToolDefinition,
  ToolLine,
  ToolPresenter,
  ToolResult,
} from "@amira/api"
import { textResult } from "@amira/api"
import {
  allDone,
  counts,
  current,
  guidance,
  isMeaningful,
  itemLine,
  listText,
  MARKS,
  panelLines,
  parseTodos,
  progressText,
  type Todo,
} from "./todos.ts"

export * from "./todos.ts"

export const WRITE_TOOL = "todo_write"
export const READ_TOOL = "todo_read"
/** The key the lists go under in the session (SessionData). */
export const DATA_KEY = "todo"
export const PANEL_ID = "todo"

/** What a todo_write call records in the session: the new list, and whether it was committed. */
export interface TodoRecord {
  todos: Todo[]
  /** The transcript shows this list (it changed meaningfully, see isMeaningful). */
  snapshot: boolean
}

/** What a todo_write result carries for the transcript. */
export interface TodoDetails {
  todos: Todo[]
  snapshot: boolean
}

interface State {
  todos: Todo[]
  /** The list the transcript showed last. */
  committed: Todo[] | undefined
  /** All done and a turn has ended since: the panel steps aside until the next list. */
  hidden: boolean
}

function isRecord(r: unknown): r is TodoRecord {
  return !!r && typeof r === "object" && Array.isArray((r as TodoRecord).todos)
}

/** A session's state from what it recorded: its latest list, and the latest one committed. */
export function restore(records: readonly unknown[]): State {
  const valid = records.filter(isRecord).flatMap((r) => {
    const parsed = parseTodos(r.todos)
    return "todos" in parsed ? [{ todos: parsed.todos, snapshot: r.snapshot === true }] : []
  })
  const last = valid.at(-1)
  const todos = last?.todos ?? []
  return {
    todos,
    committed: valid.findLast((r) => r.snapshot)?.todos,
    // A list finished in an earlier run has nothing more to show.
    hidden: allDone(todos),
  }
}

const DESCRIPTION = `Keeps this session's todo list, which the user sees live under the conversation. Use it for multi-step work: a task with three or more distinct steps, or several tasks the user gave at once. Skip it for a single simple step or a plain question.

Each call replaces the whole list, so always pass every item: {id, content, status, activeForm?}, where status is pending, in_progress or done, content says what to do ("Run the tests") and activeForm says it in the present continuous ("Running the tests"), shown while the item is in progress.

- Write the plan before you start, then keep the list current as you work.
- Keep exactly one item in_progress: mark it in_progress before you begin it, done as soon as it is finished (never several at once afterwards), then move the next one to in_progress.
- Mark an item done only when it is fully complete; if it is blocked or failing, keep it in_progress and add an item for what must be solved.
- Add steps you discover, and remove ones that no longer apply.`

type WriteParams = { todos?: unknown }

/** The list a call's arguments hold, when they are valid. */
function argTodos(args: Record<string, unknown>): Todo[] | undefined {
  const parsed = parseTodos(args.todos)
  return "todos" in parsed ? parsed.todos : undefined
}

/**
 * Whether a todo_write call's list went to the transcript. A resumed call has no details; the
 * lists that were committed are the ones whose result gave the model the whole list back.
 */
function committed(call: ToolCallView<Record<string, unknown>, TodoDetails>): boolean {
  return call.result.details?.snapshot ?? /^\[(x|>| )\] /m.test(call.text)
}

/** How the transcript shows todo_write calls: progress on the head, the list when it was committed. */
export const writePresenter: ToolPresenter<Record<string, unknown>, TodoDetails> = {
  summary(args) {
    const todos = argTodos(args)
    if (!todos) return ""
    if (!todos.length) return "clear"
    const c = counts(todos)
    return `${c.done}/${c.total} done`
  },
  result(call) {
    if (call.result.isError) return undefined
    const todos = call.result.details?.todos ?? argTodos(call.args)
    if (!todos) return undefined
    if (!todos.length) return "cleared the list"
    if (allDone(todos)) return "all done"
    // A committed call shows the list under it, the item in progress included.
    if (committed(call)) return `plan · ${todos.length} ${todos.length === 1 ? "item" : "items"}`
    const now = current(todos)
    return now ? `${MARKS.in_progress} ${now.activeForm ?? now.content}` : progressText(todos)
  },
  body(call) {
    if (call.result.isError) return []
    const todos = call.result.details?.todos ?? argTodos(call.args)
    if (!todos || !committed(call)) return []
    return todos.map((t): ToolLine => itemLine(t))
  },
  running: () => [],
}

export const readPresenter: ToolPresenter = {
  summary: () => "",
  result(call) {
    return call.result.isError ? undefined : (call.text.split("\n")[0] ?? "")
  },
  body: () => [],
}

export function createTodoExtension(): Extension {
  return (api: ExtensionAPI) => {
    const states = new Map<string, State>()

    /** A session's state, read back from its records the first time it is asked for. */
    const stateFor = (sessionId: string, data: SessionData | undefined): State | undefined => {
      let s = states.get(sessionId)
      if (s) return s
      // Without the session's records there is nothing to restore from yet; ask again later.
      if (!data) return undefined
      try {
        s = restore(data.read(DATA_KEY))
      } catch (err) {
        api.reportError(
          `todo: could not read the session's lists: ${err instanceof Error ? err.message : err}`,
        )
        s = { todos: [], committed: undefined, hidden: false }
      }
      states.set(sessionId, s)
      return s
    }
    const blank = (): State => ({ todos: [], committed: undefined, hidden: false })

    const write: ToolDefinition<WriteParams> = {
      name: WRITE_TOOL,
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The whole list, in order. An empty list clears it.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: 'A short, stable id, e.g. "1".' },
                content: { type: "string", description: 'What to do, e.g. "Run the tests".' },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
                activeForm: {
                  type: "string",
                  description: 'The same in the present continuous, e.g. "Running the tests".',
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      concurrency: "serial",
      async execute(p, ctx): Promise<ToolResult> {
        const parsed = parseTodos(p.todos)
        if ("error" in parsed) return textResult(parsed.error, true)
        const { todos } = parsed
        const sessionId = ctx.session?.sessionId ?? "default"
        const data = ctx.session?.data
        let state = stateFor(sessionId, data)
        if (!state) {
          state = blank()
          states.set(sessionId, state)
        }
        const snapshot = isMeaningful(state.committed, todos)
        const unchanged = JSON.stringify(state.todos) === JSON.stringify(todos)
        state.todos = todos
        if (snapshot) state.committed = todos
        state.hidden = false
        if (!unchanged || snapshot) data?.append(DATA_KEY, { todos, snapshot } satisfies TodoRecord)
        api.requestRender()
        const lines = [todos.length ? `Todo list updated: ${progressText(todos)}` : "Todo list cleared."]
        // The model gets the whole list back only when it is committed; the transcript shows it then.
        if (snapshot && todos.length) lines.push(listText(todos))
        const note = guidance(todos)
        if (note) lines.push(note)
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { todos, snapshot } satisfies TodoDetails,
        }
      },
    }

    const read: ToolDefinition = {
      name: READ_TOOL,
      description:
        "Reads this session's todo list (see todo_write): every item with its id and status, [x] done, [>] in progress, [ ] pending.",
      parameters: { type: "object", properties: {} },
      concurrency: "parallel",
      async execute(_p, ctx): Promise<ToolResult> {
        const state = stateFor(ctx.session?.sessionId ?? "default", ctx.session?.data)
        const todos = state?.todos ?? []
        return textResult(todos.length ? `${progressText(todos)}\n${listText(todos)}` : listText(todos))
      },
    }

    api.registerTool(write)
    api.registerTool(read)
    api.registerToolRenderer(WRITE_TOOL, writePresenter)
    api.registerToolRenderer(READ_TOOL, readPresenter)

    api.registerPanel({
      id: PANEL_ID,
      render(opts) {
        const state = stateFor(opts.sessionId, opts.data)
        if (!state || state.hidden) return []
        return panelLines(state.todos)
      },
    })

    api.registerCommand({
      name: "todos",
      description: "Show this session's todo list",
      run(_args, ctx) {
        const state = stateFor(ctx.session.info().id, ctx.session.data)
        const todos = state?.todos ?? []
        if (!todos.length) {
          ctx.print("The todo list is empty.")
          return
        }
        ctx.print(
          panelLines(todos, Number.POSITIVE_INFINITY)
            .map((l) => l.text)
            .join("\n"),
        )
      },
    })

    // A finished list stays in view until the turn that finished it ends.
    api.on("turn.end", (e) => {
      const state = states.get(e.sessionId)
      if (state && !state.hidden && allDone(state.todos)) {
        state.hidden = true
        api.requestRender()
      }
    })
  }
}

export default createTodoExtension()
