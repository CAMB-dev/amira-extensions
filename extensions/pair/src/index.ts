import { defineExtension, defineTool, type ExtensionAPI, type FrontendView, textResult } from "@amira/api"
import { serializeHandoffMarkdown } from "./handoff.ts"
import { PairManager, type StartPairOptions } from "./session.ts"
import type { HandoffKind, PairContextMode, PairScope } from "./types.ts"
import { createPairPanel, createPairStatusItem, createPairView, PAIR_VIEW_KIND } from "./view.ts"

const HELP_TEXT = [
  "Usage: /pair <subcommand>",
  "",
  "Subcommands:",
  "  /pair                       Open the Pair dock",
  "  /pair start [options]       Start a Pair room (auto-launches local relay or uses --relay)",
  "  /pair join <invite|code>    Join a teammate's room (ws://host:port#code or code + --relay)",
  "  /pair status                Show room invite, connected peers, and safety codes",
  "  /pair brief                 Refresh the shareable teammate context brief",
  "  /pair handoffs              List proposed and accepted handoffs",
  "  /pair leave                 Leave the current Pair room",
  "",
  "Start/Join options:",
  "  --name <name>               Your display name in the room",
  "  --role <role>               Your role (e.g. pm, dev, fe, be, qa)",
  "  --scope <scope>             ask-only (default) | read-context | handoff (repeatable)",
  "  --brief                     Use curated summary brief instead of btw-style live-fork",
  "  --lan                       Bind local relay to 0.0.0.0 for LAN P2P pairing",
  "  --relay <ws-url>            Connect through an external zero-knowledge WS relay",
  "  --approve-replies           Require local approval before sending agent replies",
].join("\n")

function parseFlags(tokens: string[]): { positional: string[]; opts: StartPairOptions } {
  const positional: string[] = []
  const scopes: PairScope[] = []
  let name: string | undefined
  let role: string | undefined
  let contextMode: PairContextMode | undefined
  let relayUrl: string | undefined
  let lan = false
  let approveReplies = false

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const next = () => {
      const val = tokens[++i]
      if (val === undefined) throw new Error(`Missing value for ${t}`)
      return val
    }
    if (t === "--name") name = next()
    else if (t === "--role") role = next()
    else if (t === "--relay") relayUrl = next()
    else if (t === "--lan") lan = true
    else if (t === "--brief") contextMode = "brief"
    else if (t === "--live-fork") contextMode = "live-fork"
    else if (t === "--approve-replies") approveReplies = true
    else if (t === "--scope") {
      const s = next() as PairScope
      if (s !== "ask-only" && s !== "read-context" && s !== "handoff") {
        throw new Error(`Invalid scope "${s}"; use ask-only, read-context, or handoff`)
      }
      scopes.push(s)
    } else {
      positional.push(t)
    }
  }
  return {
    positional,
    opts: {
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
      ...(scopes.length ? { scopes } : {}),
      ...(contextMode ? { contextMode } : {}),
      ...(relayUrl ? { relayUrl } : {}),
      ...(lan ? { lan } : {}),
      ...(approveReplies ? { approveReplies } : {}),
    },
  }
}

const SUBCOMMANDS = [
  { value: "start ", label: "start", description: "Start a new E2EE Pair room" },
  { value: "join ", label: "join", description: "Join an existing Pair room by invite or code" },
  { value: "status", label: "status", description: "Show room invite, peers, and safety codes" },
  { value: "brief", label: "brief", description: "Refresh shareable brief from main session" },
  { value: "handoffs", label: "handoffs", description: "List handoff snapshots" },
  { value: "leave", label: "leave", description: "Disconnect and close the Pair room" },
  { value: "help", label: "help", description: "Show /pair usage and options" },
] as const

export default defineExtension((api: ExtensionAPI) => {
  const manager = new PairManager(api, () => api.requestRender())

  const openDock = (): boolean => {
    const view: FrontendView = { kind: PAIR_VIEW_KIND, placement: "dock", data: {} }
    return api.openView?.(view) ?? false
  }

  api.registerStatusItem(createPairStatusItem(manager))
  api.registerPanel(createPairPanel(manager))
  api.registerView(
    createPairView(manager, {
      onInjectHandoff: (id) => {
        const h = manager.handoffs.find((item) => item.id === id)
        if (!h) return
        const md = serializeHandoffMarkdown(h)
        void api
          .session()
          ?.send(
            `Incorporate the following accepted teammate handoff (${h.title}, v${h.version}):\n\n${md}`,
            { display: { text: `Injected handoff: ${h.title} (v${h.version})`, origin: "pair" } },
          )
      },
      onLeave: () => void manager.leave(),
    }),
  )

  api.on("ui.focus", (ev) => {
    manager.setFocused(ev.data.focused)
  })

  // Direct human-to-human message shortcut: `@alice what do you think?`
  api.registerInputHandler({
    name: "pair",
    claims(text) {
      if (!manager.active || !text.startsWith("@")) return false
      const space = text.indexOf(" ")
      if (space <= 1) return false
      const target = text.slice(1, space)
      const body = text.slice(space + 1).trim()
      return Boolean(body && manager.resolvePeer(target))
    },
    run(text, ctx) {
      const space = text.indexOf(" ")
      const target = text.slice(1, space)
      const body = text.slice(space + 1).trim()
      manager.sendChat(target, body)
      ctx.print(`[pair → ${target}] ${body}`, "info")
    },
  })

  api.registerTool(
    defineTool<Record<string, never>>({
      name: "pair_status",
      description:
        "Inspect connected Pair teammates (names, roles, granted scopes, and safety codes) before calling pair_ask or pair_handoff.",
      mainOnly: true,
      traits: { readOnly: true },
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        if (!manager.active)
          return textResult("Pair is not active. Ask the user to run /pair start or /pair join.")
        const peers = manager.peers()
        if (!peers.length)
          return textResult(`Pair room ${manager.code} is active, waiting for teammates to join.`)
        const lines = peers.map(
          (p) => `- ${p.name} (role: ${p.role}, scopes: ${p.scopes.join(", ")}, safety: ${p.safetyCode})`,
        )
        return textResult(`Connected Pair teammates:\n${lines.join("\n")}`)
      },
    }),
  )

  api.registerTool(
    defineTool<{ peer: string; question: string; taskId?: string; context?: string }>({
      name: "pair_ask",
      description:
        "Ask a connected teammate's isolated Amira agent a question (e.g. grill a PM's agent to clarify ambiguous requirements or align on an API contract). Streams progress if the teammate's human needs to make a decision.",
      mainOnly: true,
      traits: { readOnly: true },
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["peer", "question"],
        properties: {
          peer: { type: "string", description: "Teammate name, role (e.g. 'pm'), or peerId." },
          question: { type: "string", description: "Clear, specific question(s) for the teammate's agent." },
          taskId: {
            type: "string",
            description: "Optional taskId to continue an earlier clarification thread.",
          },
          context: { type: "string", description: "Optional concise context from your side." },
        },
      },
      async execute(args, ctx) {
        try {
          const res = await manager.askPeer({
            peer: args.peer,
            question: args.question,
            taskId: args.taskId,
            context: args.context,
            signal: ctx.signal,
            onStatus(state, detail) {
              ctx.update(textResult(`[${state}] ${detail}`))
            },
          })
          return textResult(
            `Reply from ${res.peerName} (taskId: ${res.taskId}):\n\n${res.answer}${
              res.redactedCount ? `\n\n(${res.redactedCount} secret pattern(s) redacted by sender)` : ""
            }`,
          )
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true)
        }
      },
    }),
  )

  api.registerTool(
    defineTool<{
      peer: string
      kind: HandoffKind
      title: string
      content: string
      decisions?: string[]
      openQuestions?: string[]
      acceptanceCriteria?: string[]
      id?: string
    }>({
      name: "pair_handoff",
      description:
        "Propose a structured, versioned Handoff artifact (requirements, api-contract, design-notes, or review) to a connected teammate for dual-signed acceptance and local .amira/handoffs/ persistence.",
      mainOnly: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["peer", "kind", "title", "content"],
        properties: {
          peer: { type: "string", description: "Recipient teammate name, role, or peerId." },
          kind: { type: "string", enum: ["requirements", "api-contract", "design-notes", "review"] },
          title: { type: "string" },
          content: { type: "string", description: "Structured Markdown specification or summary." },
          decisions: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          id: { type: "string", description: "Existing handoff id to propose a bumped version (v2, v3...)." },
        },
      },
      async execute(args) {
        try {
          const h = manager.proposeHandoff(args)
          return textResult(
            `Proposed ${h.kind} handoff "${h.title}" (id: ${h.id}, v${h.version}, sha256: ${h.sha256.slice(0, 12)}) to ${h.toName}. Waiting for ${h.toName} to accept in their Pair Dock.`,
          )
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true)
        }
      },
    }),
  )

  api.registerCommand({
    name: "pair",
    description: "Connect isolated Amira agents across machines for A2A grilling, handoffs & collaboration",
    args: {
      hint: "start | join <invite> | status | brief | handoffs | leave",
      complete(text) {
        const trimmed = text.trimStart()
        return SUBCOMMANDS.filter((s) => s.label.startsWith(trimmed)).map((s) => ({
          value: s.value,
          label: s.label,
          description: s.description,
        }))
      },
    },
    async run(rawArgs, ctx) {
      const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
      const sub = tokens[0]?.toLowerCase()

      if (!sub) {
        const opened = ctx.openView?.({ kind: PAIR_VIEW_KIND, placement: "dock", data: {} }) ?? openDock()
        if (!opened) ctx.print(HELP_TEXT, "info")
        return
      }
      if (sub === "help" || sub === "--help" || sub === "-h") {
        ctx.print(HELP_TEXT, "info")
        return
      }
      if (sub === "start") {
        try {
          const { opts } = parseFlags(tokens.slice(1))
          const { code, relayUrl, invite } = await manager.start(opts)
          ctx.openView?.({ kind: PAIR_VIEW_KIND, placement: "dock", data: {} })
          ctx.print(
            [
              `Pair room started [E2EE]`,
              `  Code:   ${code}`,
              `  Relay:  ${relayUrl}`,
              `  Invite: /pair join ${invite}`,
            ].join("\n"),
            "info",
          )
        } catch (err) {
          ctx.print(err instanceof Error ? err.message : String(err), "error")
        }
        return
      }
      if (sub === "join") {
        try {
          const { positional, opts } = parseFlags(tokens.slice(1))
          const target = positional[0]
          if (!target) {
            ctx.print(
              "Usage: /pair join <ws://host:port#code> (or /pair join <code> --relay <ws-url>)",
              "error",
            )
            return
          }
          const res = await manager.join(target, opts)
          ctx.openView?.({ kind: PAIR_VIEW_KIND, placement: "dock", data: {} })
          ctx.print(`Joined Pair room ${res.code} via ${res.relayUrl} [E2EE]`, "info")
        } catch (err) {
          ctx.print(err instanceof Error ? err.message : String(err), "error")
        }
        return
      }
      if (sub === "status") {
        if (!manager.active) {
          ctx.print("Not connected to a Pair room.", "info")
          return
        }
        const peers = manager.peers()
        ctx.print(
          [
            `Pair room: ${manager.code} (${manager.relayUrl})`,
            `Local: ${manager.localCard?.name} (${manager.localCard?.role}) · ${manager.localCard?.contextMode}`,
            `Peers (${peers.length}):`,
            ...(peers.length
              ? peers.map((p) => `  - ${p.name} (${p.role}) [${p.safetyCode}] scopes=${p.scopes.join(",")}`)
              : ["  (none yet)"]),
            `Pending decisions: ${manager.pendingDecisionCount}`,
          ].join("\n"),
          "info",
        )
        return
      }
      if (sub === "brief") {
        const brief = await manager.refreshBrief()
        ctx.print(`Refreshed shareable brief:\n\n${brief}`, "info")
        return
      }
      if (sub === "handoffs") {
        const list = manager.handoffs
        if (!list.length) {
          ctx.print("No handoffs in this session.", "info")
          return
        }
        ctx.print(
          list
            .map(
              (h) =>
                `- [${h.status}] ${h.id} v${h.version} (${h.kind}) "${h.title}" from ${h.fromName}${h.localPath ? ` → ${h.localPath}` : ""}`,
            )
            .join("\n"),
          "info",
        )
        return
      }
      if (sub === "leave") {
        await manager.leave()
        ctx.print("Left Pair room.", "info")
        return
      }
      ctx.print(`Unknown /pair subcommand "${sub}". Run /pair help.`, "error")
    },
  })

  api.provideService("pair.peers", () => manager.peers())
  api.provideService("pair.ask", (req) => manager.askPeer(req))
  api.provideService("pair.handoffs", () => [...manager.handoffs])

  api.onUnload(() => {
    manager.dispose()
  })
})
