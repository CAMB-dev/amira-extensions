import type { ViewDefinition, ViewLine } from "@amira/api"
import { EVENT_LABEL, type Hook } from "./config.ts"
import { type HookRun, outcome, seconds } from "./runner.ts"

export const VIEW_KIND = "hooks"

export interface ViewData {
  /** Oldest first; the view reads it again at each redraw, so new runs show up. */
  runs: readonly HookRun[]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)

function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
}

/** A configured hook in one line: name, what it applies to, what it does, where it is from. */
export function hookLine(h: Hook): string {
  const parts = [h.name]
  if (h.event === "beforeTool") {
    const tools = h.tools.join(", ")
    const match = h.match.map((m) => `${m.arg} ~ /${m.re.source}/${m.re.flags}`).join(", ")
    parts.push(match ? `${tools} with ${match}` : tools)
  }
  if (h.event === "afterEdit") {
    parts.push(h.files.length ? h.files.join(", ") : "every file")
    if (h.tools.join() !== "edit,write") parts.push(`after ${h.tools.join(", ")}`)
  }
  if (h.event === "afterTurn") {
    const when = [
      h.on.join("/") === "done" ? "" : `on ${h.on.join(", ")}`,
      h.onlyAfterEdits ? "only after edits" : "",
    ]
    parts.push(...when.filter(Boolean))
  }
  if (h.event === "sessionStart" && h.reasons.length) parts.push(`on ${h.reasons.join(", ")}`)
  parts.push(h.command ? clip(h.command, 80) : `${h.action}${h.reason ? `: ${h.reason}` : ""}`)
  if (h.event === "afterEdit" && h.feedback !== "onError") parts.push(`feedback ${h.feedback}`)
  if (h.shell === "powershell") parts.push("powershell")
  parts.push(h.origin)
  return parts.join(" · ")
}

/** A run in one line: when, event, hook, target, outcome, time. */
export function runLine(r: HookRun): string {
  const mark = r.ok ? "✓" : "✗"
  const target = r.target ? ` · ${r.target}` : ""
  const time = r.verdict ? "" : ` · ${seconds(r.durationMs)}`
  return `${clock(r.startedAt)} ${mark} ${EVENT_LABEL[r.hook.event]} · ${r.hook.name}${target} · ${outcome(r)}${time}`
}

/** `/hooks runs` in the TUI: every recent run with its output, the latest at the bottom. */
export const view: ViewDefinition<ViewData> = {
  kind: VIEW_KIND,
  title: () => "Hooks · recent runs",
  header: (d) => {
    const failed = d.runs.filter((r) => !r.ok).length
    return [
      {
        kind: "muted",
        text: `${d.runs.length} run${d.runs.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed or blocked` : ""}`,
      },
    ]
  },
  render: (d, opts) => {
    const out: ViewLine[] = []
    for (const r of d.runs) {
      if (out.length) out.push({ kind: "text", text: "" })
      out.push({ kind: r.ok ? "success" : "error", text: clip(runLine(r), opts.width) })
      if (r.hook.command) out.push({ kind: "muted", text: clip(`  $ ${r.hook.command}`, opts.width) })
      if (r.verdict) continue
      const lines = r.output ? r.output.split("\n") : []
      if (!lines.length) out.push({ kind: "muted", text: "  (no output)" })
      for (const l of lines) out.push({ kind: "code", text: clip(`  ${l}`, opts.width) })
    }
    if (!out.length) out.push({ kind: "muted", text: "No hook has run yet." })
    return out
  },
  follow: true,
}
