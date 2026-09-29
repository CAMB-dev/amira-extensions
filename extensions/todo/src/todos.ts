import type { ViewLine } from "@amira/api"

export type TodoStatus = "pending" | "in_progress" | "done"

export interface Todo {
  id: string
  content: string
  status: TodoStatus
  /** The item in the present continuous ("Running the tests"), shown while it is in progress. */
  activeForm?: string
}

/** The most items a list may hold. */
export const MAX_TODOS = 50
/** The longest an item's text may be; longer text is cut. */
export const MAX_CONTENT = 300

/** The marks of each status, in the panel and in the transcript. */
export const MARKS: Record<TodoStatus, string> = { done: "✓", in_progress: "›", pending: "•" }

/** Spellings models use for the statuses, e.g. Claude Code's "completed". */
const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: "pending",
  todo: "pending",
  not_started: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  doing: "in_progress",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The list a todo_write call asked for, checked: every item needs content and a known status;
 * ids default to the item's position and must be unique. Returns the problem otherwise.
 */
export function parseTodos(raw: unknown): { todos: Todo[] } | { error: string } {
  if (!Array.isArray(raw))
    return { error: '"todos" must be an array of items (an empty one clears the list).' }
  if (raw.length > MAX_TODOS) return { error: `A list holds at most ${MAX_TODOS} items; merge some.` }
  const todos: Todo[] = []
  const seen = new Set<string>()
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") return { error: `Item ${i + 1} is not an object.` }
    const r = item as Record<string, unknown>
    const content = typeof r.content === "string" ? clip(oneLine(r.content), MAX_CONTENT) : ""
    if (!content) return { error: `Item ${i + 1} has no "content".` }
    const status =
      STATUS_ALIASES[
        String(r.status ?? "pending")
          .toLowerCase()
          .trim()
      ]
    if (!status)
      return { error: `Item ${i + 1} has status "${String(r.status)}"; use pending, in_progress or done.` }
    const id =
      typeof r.id === "string" || typeof r.id === "number"
        ? oneLine(String(r.id)) || String(i + 1)
        : String(i + 1)
    if (seen.has(id)) return { error: `Two items have the id "${id}"; ids must be unique.` }
    seen.add(id)
    const active = typeof r.activeForm === "string" ? clip(oneLine(r.activeForm), MAX_CONTENT) : ""
    todos.push({ id, content, status, ...(active ? { activeForm: active } : {}) })
  }
  return { todos }
}

export interface Counts {
  total: number
  done: number
  inProgress: number
  pending: number
}

export function counts(todos: readonly Todo[]): Counts {
  const c = { total: todos.length, done: 0, inProgress: 0, pending: 0 }
  for (const t of todos) {
    if (t.status === "done") c.done++
    else if (t.status === "in_progress") c.inProgress++
    else c.pending++
  }
  return c
}

export const allDone = (todos: readonly Todo[]) => todos.length > 0 && todos.every((t) => t.status === "done")

/** What the list is about: its items' ids and text, without their statuses. */
const shape = (todos: readonly Todo[]) => JSON.stringify(todos.map((t) => [t.id, t.content]))

/**
 * Whether a new list is worth committing to the transcript, measured against the last one
 * that was: the first list, a changed plan (items added, removed or reworded), everything done
 * (only once), and a cleared list. Items only moving on (pending, in progress, done) are not;
 * the live panel shows those.
 */
export function isMeaningful(last: readonly Todo[] | undefined, next: readonly Todo[]): boolean {
  if (!last?.length) return next.length > 0
  if (!next.length) return true
  if (shape(last) !== shape(next)) return true
  return allDone(next) && !allDone(last)
}

/** The item a list is working on: its first in progress. */
export const current = (todos: readonly Todo[]) => todos.find((t) => t.status === "in_progress")

/** An item as the model reads it back: `[x] 3. content`. */
function modelLine(t: Todo): string {
  const box = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"
  return `${box} ${t.id}. ${t.content}`
}

/** One line about the list for the model: how far it is and what is in progress. */
export function progressText(todos: readonly Todo[]): string {
  if (!todos.length) return "The todo list is empty."
  const c = counts(todos)
  const now = current(todos)
  return `${c.done} of ${c.total} done${now ? `; in progress: ${now.content}` : ""}.`
}

/** The whole list for the model (todo_read, and todo_write results worth committing). */
export function listText(todos: readonly Todo[]): string {
  return todos.length ? todos.map(modelLine).join("\n") : "The todo list is empty."
}

/**
 * A reminder for lists that do not keep to one item in progress, for the todo_write result;
 * undefined when the list is fine.
 */
export function guidance(todos: readonly Todo[]): string | undefined {
  const c = counts(todos)
  if (c.inProgress > 1)
    return `Note: ${c.inProgress} items are in progress; keep exactly one in progress and finish it before starting the next.`
  if (c.inProgress === 0 && c.pending > 0)
    return "Note: nothing is in progress; mark the item you work on now as in_progress."
  return undefined
}

/** An item as a panel or transcript line: done muted, in progress accent (its activeForm), pending plain. */
export function itemLine(t: Todo, indent = ""): ViewLine {
  if (t.status === "done") return { kind: "muted", text: `${indent}${MARKS.done} ${t.content}` }
  if (t.status === "in_progress")
    return { kind: "accent", text: `${indent}${MARKS.in_progress} ${t.activeForm ?? t.content}` }
  return { kind: "text", text: `${indent}${MARKS.pending} ${t.content}` }
}

/** The panel's first line, all that shows when panels are folded: `Todos 2/5 · › Running tests`. */
export function headerLine(todos: readonly Todo[]): ViewLine {
  const c = counts(todos)
  const now = current(todos)
  const tail = now
    ? ` · ${MARKS.in_progress} ${now.activeForm ?? now.content}`
    : allDone(todos)
      ? " · all done"
      : ""
  return { kind: "muted", text: `Todos ${c.done}/${c.total}${tail}` }
}

/** The most lines the panel shows under its header. */
export const PANEL_ITEMS = 8

/**
 * The live panel: the header, then the items. A longer list than `max` lines shows a window
 * that keeps the item in progress (else the first one not done) in view, with a line each for
 * what is left out above and below, all within `max` lines.
 */
export function panelLines(todos: readonly Todo[], max = PANEL_ITEMS): ViewLine[] {
  if (!todos.length) return []
  const items = todos.map((t) => itemLine(t, "  "))
  if (items.length <= max) return [headerLine(todos), ...items]
  const working = todos.findIndex((t) => t.status === "in_progress")
  const open = todos.findIndex((t) => t.status !== "done")
  const focus = working >= 0 ? working : open >= 0 ? open : items.length - 1
  // Room for items once the "above" and "below" lines are counted (both, in the worst case).
  const room = Math.max(1, max - 2)
  // One item of context before the focus, and the window never runs past the end.
  let start = Math.min(Math.max(0, focus - 1), items.length - room)
  let end = start + room
  // A window at either edge needs no line there, which leaves room for one more item.
  if (start <= 1) {
    start = 0
    end = max - 1
  } else if (end >= items.length - 1) {
    end = items.length
    start = items.length - (max - 1)
  }
  return [
    headerLine(todos),
    ...(start > 0 ? [{ kind: "muted" as const, text: `  … ${start} above` }] : []),
    ...items.slice(start, end),
    ...(end < items.length ? [{ kind: "muted" as const, text: `  … ${items.length - end} more` }] : []),
  ]
}
