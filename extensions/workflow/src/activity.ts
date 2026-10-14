import type { AnyEvent } from "@amira/api"
import type { AgentNode } from "./progress.ts"

/** Consume only the selected child's activity, never its descendants' or the workflow's log. */
export function observeAgentEvent(node: AgentNode, event: AnyEvent): boolean {
  const stateEvent = event.type === "subagent.state" && event.data.childSessionId === node.childId
  if (!stateEvent && event.sessionId !== node.childId) return false
  let text: string | undefined
  if (event.type === "tool.execute.start") {
    node.currentTools = [...(node.currentTools ?? []), { id: event.data.toolCallId, name: event.data.name }]
    text = `Started ${event.data.name}`
  } else if (event.type === "tool.execute.end") {
    node.currentTools = node.currentTools?.filter((tool) => tool.id !== event.data.toolCallId)
    const result = event.data.result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    text = `${event.data.name}: ${event.data.result.isError ? "failed" : "done"}${result ? ` · ${result}` : ""}`
  } else if (event.type === "session.start") {
    text = "Started agent"
  } else if (event.type === "subagent.state" && stateEvent) {
    if (node.status === "queued" || node.status === "working")
      node.status = event.data.state === "queued" ? "queued" : "working"
    node.paused = event.data.state === "paused"
    node.idle = event.data.state === "idle"
    text = `State: ${event.data.state}`
  } else if (event.type === "message.end") {
    text = "Received response"
  }
  if (text === undefined) return false
  node.lastAction = text.replace(/\s+/g, " ").slice(0, 160)
  node.events = [...(node.events ?? []), { ts: event.ts, text }].slice(-50)
  return true
}
