import type {
  PanelDefinition,
  PanelLine,
  StatusItem,
  UiContext,
  UiControl,
  UiEvent,
  UiNode,
  ViewDefinition,
  ViewLine,
} from "@amira/api"
import type { PairManager } from "./session.ts"

export const PAIR_VIEW_KIND = "pair-dock"

export function createPairStatusItem(manager: PairManager): StatusItem {
  return {
    id: "pair",
    align: "right",
    priority: 35,
    tone() {
      if (!manager.active) return "muted"
      if (manager.pendingDecisionCount > 0) return "warning"
      return manager.peers().length > 0 ? "success" : "accent"
    },
    text() {
      if (!manager.active) return undefined
      const peers = manager.peers()
      const pending = manager.pendingDecisionCount
      const peerLabel = peers.length === 1 ? peers[0]!.name : `${peers.length} peers`
      return pending > 0 ? `Pair: ${peerLabel} · ${pending} pending` : `Pair: ${peerLabel} [E2EE]`
    },
  }
}

export function createPairPanel(manager: PairManager): PanelDefinition {
  return {
    id: "pair-panel",
    order: 30,
    render(): PanelLine[] {
      if (!manager.active) return []
      const peers = manager.peers()
      const pending = manager.decisions.filter((d) => d.status === "pending")
      const proposedHandoffs = manager.handoffs.filter((h) => h.status === "proposed")
      if (pending.length === 0 && proposedHandoffs.length === 0) return []
      const lines: PanelLine[] = [
        {
          kind: "segments",
          parts: [
            { kind: "chip", text: "PAIR", tone: pending.length > 0 ? "warning" : "accent" },
            { kind: "text", text: ` ${peers.length} peer(s)` },
            ...(pending.length
              ? [{ kind: "warning" as const, text: ` · ${pending.length} decision(s) waiting` }]
              : []),
            ...(proposedHandoffs.length
              ? [{ kind: "accent" as const, text: ` · ${proposedHandoffs.length} handoff(s) to review` }]
              : []),
          ],
        },
      ]
      for (const card of pending.slice(0, 2)) {
        lines.push({
          kind: "segments",
          parts: [
            { kind: "warning", text: `  ? [${card.fromName}] ` },
            { kind: "text", text: `${card.topic}: ${card.questions[0]?.prompt.slice(0, 72) ?? ""}` },
          ],
        })
      }
      return lines
    },
  }
}

export function createPairView(
  manager: PairManager,
  actions: {
    onInjectHandoff: (id: string) => void
    onLeave: () => void
  },
): ViewDefinition {
  let latestReplyDraft = ""
  return {
    kind: PAIR_VIEW_KIND,
    needsTab: true,
    title: () => {
      if (!manager.active) return "Pair"
      const pending = manager.pendingDecisionCount
      return pending > 0 ? `Pair · ${manager.code} (${pending} pending)` : `Pair · ${manager.code} [E2EE]`
    },
    ui(_data: unknown, ctx: UiContext): UiNode {
      latestReplyDraft = ctx.state.inputValues["decision-reply"] ?? ""
      if (!manager.active) {
        return {
          type: "column",
          gap: 1,
          children: [
            {
              node: {
                type: "text",
                lines: [
                  { kind: "muted", text: "Not connected to a Pair room." },
                  {
                    kind: "accent",
                    text: "Host: /pair start [--role pm|dev] [--scope ask-only|read-context] [--lan]",
                  },
                  { kind: "accent", text: "Join: /pair join <ws://host:port#code>" },
                ],
              },
            },
            {
              node: {
                type: "row",
                gap: 1,
                children: [{ node: { type: "button", id: "close", label: "Close" }, size: 10 }],
              },
              size: 1,
            },
          ],
        }
      }

      const peers = manager.peers()
      const pendingDecisions = manager.decisions.filter((d) => d.status === "pending")
      const activeDecision = pendingDecisions[0]
      const handoffs = manager.handoffs
      const latestHandoff = handoffs[0]

      const peerLines: ViewLine[] = [
        {
          kind: "segments",
          parts: [
            { kind: "muted", text: "Invite: " },
            { kind: "accent", text: `${manager.relayUrl}#${manager.code}` },
          ],
        },
        {
          kind: "segments",
          parts: [
            { kind: "muted", text: "Local: " },
            {
              kind: "text",
              text: `${manager.localCard?.name} (${manager.localCard?.role}) · context: ${manager.localCard?.contextMode} · scopes: ${manager.localCard?.scopes.join(", ")}`,
            },
          ],
        },
        ...(peers.length
          ? peers.map(
              (p): ViewLine => ({
                kind: "segments",
                parts: [
                  { kind: "success", text: "● " },
                  { kind: "text", text: `${p.name} (${p.role}) ` },
                  { kind: "muted", text: `[${p.safetyCode}] · ${p.scopes.join(", ")}` },
                ],
              }),
            )
          : [{ kind: "muted" as const, text: "Waiting for teammates to join..." }]),
      ]

      const decisionBody: UiNode = activeDecision
        ? {
            type: "column",
            gap: 1,
            children: [
              {
                node: {
                  type: "text",
                  lines: [
                    {
                      kind: "segments",
                      parts: [
                        { kind: "chip", text: "DECISION", tone: "warning" },
                        { kind: "text", text: ` From ${activeDecision.fromName} — ${activeDecision.topic}` },
                      ],
                    },
                    ...activeDecision.questions.map(
                      (q): ViewLine => ({
                        kind: "segments",
                        parts: [
                          { kind: "accent", text: `  • ${q.prompt}` },
                          ...(q.options?.length
                            ? [{ kind: "muted" as const, text: ` [${q.options.join(" | ")}]` }]
                            : []),
                        ],
                      }),
                    ),
                  ],
                },
              },
              {
                node: {
                  type: "box",
                  title: `Reply to ${activeDecision.fromName}`,
                  border: "round",
                  tone: "focus",
                  child: {
                    type: "input",
                    id: "decision-reply",
                    placeholder: "Type your decision and press Enter (or click Answer)...",
                  },
                },
                size: 3,
              },
              {
                node: {
                  type: "row",
                  gap: 1,
                  children: [
                    {
                      node: { type: "button", id: "answer-decision", label: "Answer", tone: "accent" },
                      size: 12,
                    },
                    { node: { type: "button", id: "decline-decision", label: "Decline" }, size: 12 },
                  ],
                },
                size: 1,
              },
            ],
          }
        : {
            type: "text",
            lines: [
              { kind: "muted", text: "No pending decisions — teammates' questions answered automatically." },
            ],
          }

      const transcriptLines: ViewLine[] = manager.transcript.length
        ? manager.transcript.slice(-20).map((t) => ({
            kind: "segments",
            parts: [
              {
                kind: t.direction === "in" ? "accent" : t.direction === "out" ? "success" : "muted",
                text: `${t.direction === "in" ? "←" : t.direction === "out" ? "→" : "•"} [${t.peerName}] `,
              },
              { kind: "text", text: t.text },
            ],
          }))
        : [{ kind: "muted", text: "No pair traffic yet." }]

      const handoffBody: UiNode = latestHandoff
        ? {
            type: "column",
            gap: 1,
            children: [
              {
                node: {
                  type: "text",
                  lines: handoffs.slice(0, 5).map((h) => ({
                    kind: "segments",
                    parts: [
                      {
                        kind: "chip",
                        text: h.status.toUpperCase(),
                        tone:
                          h.status === "accepted"
                            ? "success"
                            : h.status === "proposed"
                              ? "warning"
                              : "danger",
                      },
                      { kind: "text", text: ` ${h.title} (v${h.version}, ${h.kind}) ` },
                      { kind: "muted", text: `from ${h.fromName}${h.localPath ? ` → ${h.localPath}` : ""}` },
                    ],
                  })),
                },
              },
              {
                node: {
                  type: "row",
                  gap: 1,
                  children: [
                    ...(latestHandoff.status === "proposed" &&
                    latestHandoff.fromPeerId !== manager.localCard?.peerId
                      ? [
                          {
                            node: {
                              type: "button" as const,
                              id: "accept-handoff",
                              label: "Accept Latest",
                              tone: "accent" as const,
                            },
                            size: 18,
                          },
                        ]
                      : []),
                    ...(latestHandoff.status === "accepted"
                      ? [
                          {
                            node: {
                              type: "button" as const,
                              id: "inject-handoff",
                              label: "Inject to Main",
                              tone: "accent" as const,
                            },
                            size: 18,
                          },
                        ]
                      : []),
                  ],
                },
                size: 1,
              },
            ],
          }
        : {
            type: "text",
            lines: [
              {
                kind: "muted",
                text: "No handoffs yet. Use pair_handoff tool after aligning with a teammate.",
              },
            ],
          }

      return {
        type: "column",
        gap: 1,
        children: [
          {
            node: {
              type: "tabs",
              id: "pair-tabs",
              style: "divided",
              tabs: [
                {
                  key: "peers",
                  label: `Peers (${peers.length})`,
                  body: { type: "text", id: "pair-peers", lines: peerLines },
                },
                { key: "decisions", label: `Decisions (${pendingDecisions.length})`, body: decisionBody },
                {
                  key: "transcript",
                  label: `Transcript (${manager.transcript.length})`,
                  body: { type: "text", id: "pair-transcript", lines: transcriptLines, follow: true },
                },
                { key: "handoffs", label: `Handoffs (${handoffs.length})`, body: handoffBody },
              ],
            },
          },
          {
            node: {
              type: "row",
              gap: 1,
              children: [
                { node: { type: "button", id: "leave", label: "Leave Room" }, size: 14 },
                { node: { type: "button", id: "close", label: "Hide" }, size: 10 },
              ],
            },
            size: 1,
          },
        ],
      }
    },
    onEvent(event: UiEvent, _data: unknown, control: UiControl) {
      const pending = manager.decisions.find((d) => d.status === "pending")
      if (event.type === "submit" && event.id === "decision-reply" && pending) {
        if (manager.answerDecision(pending.id, event.value)) {
          control.setState({ inputValues: { "decision-reply": "" } })
        }
        return
      }
      if (event.type !== "activate") return
      if (event.key === "answer-decision" && pending) {
        if (manager.answerDecision(pending.id, latestReplyDraft)) {
          latestReplyDraft = ""
          control.setState({ inputValues: { "decision-reply": "" } })
        } else {
          control.focus("decision-reply")
        }
      } else if (event.key === "decline-decision" && pending) {
        manager.declineDecision(pending.id)
      } else if (event.key === "accept-handoff") {
        const target = manager.handoffs.find(
          (h) => h.status === "proposed" && h.fromPeerId !== manager.localCard?.peerId,
        )
        if (target) manager.acceptHandoff(target.id)
      } else if (event.key === "inject-handoff") {
        const target = manager.handoffs.find((h) => h.status === "accepted")
        if (target) actions.onInjectHandoff(target.id)
      } else if (event.key === "leave") {
        actions.onLeave()
        control.close()
      } else if (event.key === "close") {
        control.close()
      }
    },
  }
}
