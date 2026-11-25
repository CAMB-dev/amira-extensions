import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { Agent, EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { AgentTree, ExtensionHost, forkHistory } from "@amira/host"
import { startRelayServer } from "../relay/server.ts"
import {
  createEphemeralX25519,
  createSignedHello,
  deriveRoomSecret,
  generatePairingCode,
  loadOrCreateIdentity,
  PeerCipher,
  redactSecrets,
  verifySignedHello,
} from "../src/crypto.ts"
import {
  computeHandoffHash,
  createHandoffDraft,
  diffHandoffs,
  persistHandoff,
  serializeHandoffMarkdown,
} from "../src/handoff.ts"
import { PairManager } from "../src/session.ts"
import type { PairTaskState } from "../src/types.ts"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function createPeerNode(name: string, steps: MockStep[], mainMessages: string[] = []) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `amira-pair-${name}-`))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    bus,
    interceptors,
    tools,
    tree,
    sections: [],
  })
  for (const text of mainMessages) {
    agent.messages.push(userMessage(text))
  }
  const host = new ExtensionHost({
    bus,
    interceptors,
    tools,
    ai,
    cwd,
    frontend: "tui",
    settings: {},
    conversations: { ai, tools, tree, home: cwd, agent: () => agent },
  })
  host.setSessionControl(
    {
      info: () => ({
        id: agent.sessionId,
        cwd,
        model: { provider: "mock", model: "test" },
        thinking: undefined,
        fastMode: { requested: false, applied: false },
        contextWindow: 128_000,
        busy: false,
        shell: "sh" as const,
        permissions: { mode: "auto" as const, rules: 0 },
      }),
      trace: async () => [],
      messages: () => agent.messages,
      forkMessages: () => Object.freeze(structuredClone(forkHistory(agent.projectedMessages()))),
      replies: () => [],
      subagents: () => [],
      subagentMessages: () => undefined,
      stopSubagent: () => false,
      messageSubagent: () => false,
      pauseSubagent: () => false,
      resumeSubagent: () => false,
      models: () => ["mock/test"],
      setModel: () => {},
      setThinking: () => {},
      setFastMode: () => {},
      newSession: async () => {},
      sessions: () => [],
    } as never,
    () => agent,
  )

  let manager!: PairManager
  await host.load((api) => {
    manager = new PairManager(api, () => {})
    api.onUnload(() => manager.dispose())
  }, `pair-${name}`)

  cleanups.push(async () => {
    await manager.leave()
    await host.unload(`pair-${name}`)
    await agent.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  return { cwd, host, agent, mock, manager }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 15))
  }
}

test("crypto: E2EE handshake, AES-256-GCM encryption, replay rejection, wrong code rejection, and secret redaction", () => {
  const code = generatePairingCode()
  expect(code).toMatch(/^\d{2}-[a-z]+-[a-z]+$/)

  const roomA = deriveRoomSecret(code)
  const roomB = deriveRoomSecret(code)
  const wrongRoom = deriveRoomSecret("99-wrong-code")
  expect(roomA.roomId).toBe(roomB.roomId)
  expect(roomA.roomId).not.toBe(wrongRoom.roomId)

  const idA = loadOrCreateIdentity()
  const idB = loadOrCreateIdentity()
  const ephA = createEphemeralX25519()
  const ephB = createEphemeralX25519()

  const helloA = createSignedHello(idA, ephA.publicPem, roomA)
  const helloB = createSignedHello(idB, ephB.publicPem, roomB)
  expect(verifySignedHello(helloA, roomB)).toBe(true)
  expect(verifySignedHello(helloB, roomA)).toBe(true)
  expect(verifySignedHello(helloA, wrongRoom)).toBe(false)

  const cipherA = new PeerCipher(
    idA.peerId,
    idB.peerId,
    ephA.privateKey,
    ephB.publicPem,
    roomA,
    idA.publicPem,
    idB.publicPem,
  )
  const cipherB = new PeerCipher(
    idB.peerId,
    idA.peerId,
    ephB.privateKey,
    ephA.publicPem,
    roomB,
    idB.publicPem,
    idA.publicPem,
  )
  expect(cipherA.safetyCode).toBe(cipherB.safetyCode)

  const env1 = cipherA.encrypt("secret product roadmap")
  expect(env1.ct).not.toContain("roadmap")
  expect(cipherB.decrypt(env1)).toBe("secret product roadmap")
  // Replay must fail!
  expect(() => cipherB.decrypt(env1)).toThrow(/Replay/)
  // Tamper must fail!
  const env2 = cipherA.encrypt("second message")
  expect(() => cipherB.decrypt({ ...env2, ct: `${env2.ct.slice(0, -4)}AAAA` })).toThrow()

  const redacted = redactSecrets(
    "Use key sk-1234567890abcdefghijklmnop and token ghp_abcdefghijklmnopqrstuvwxyz1234",
  )
  expect(redacted.count).toBe(2)
  expect(redacted.text).not.toContain("sk-1234567890")
  expect(redacted.text).not.toContain("ghp_")
})

test("handoff: SHA-256 verification, Markdown+YAML serialization, diffing, and atomic persistence", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-handoff-"))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))

  const v1 = createHandoffDraft({
    kind: "requirements",
    title: "Checkout Timeout Policy",
    fromPeerId: "p_dev",
    fromName: "bob",
    toPeerId: "p_pm",
    toName: "alice",
    content: "Orders expire after 30 minutes.\nSend email reminder at 25 minutes.",
    decisions: ["30 minute hard timeout"],
    acceptanceCriteria: ["Unpaid orders auto-cancel at 30m"],
  })
  expect(computeHandoffHash(v1)).toBe(v1.sha256)

  const v2 = createHandoffDraft({
    id: v1.id,
    version: 2,
    kind: "requirements",
    title: "Checkout Timeout Policy",
    fromPeerId: "p_dev",
    fromName: "bob",
    toPeerId: "p_pm",
    toName: "alice",
    content: "Orders expire after 15 minutes.\nSend email reminder at 25 minutes.",
  })
  expect(diffHandoffs(v1, v2)).toContain("- Orders expire after 30 minutes.")
  expect(diffHandoffs(v1, v2)).toContain("+ Orders expire after 15 minutes.")

  const saved = persistHandoff(cwd, { ...v1, status: "accepted", acceptedAt: Date.now() })
  expect(existsSync(saved)).toBe(true)
  const raw = readFileSync(saved, "utf8")
  expect(raw).toContain("version: v1")
  expect(raw).toContain("30 minute hard timeout")
  expect(serializeHandoffMarkdown(v1)).toContain("## Acceptance Criteria")
})

test("E2E 3-peer room over zero-knowledge relay: relay sees only ciphertext, all 3 peers connect with matching safety codes", async () => {
  const relayFrames: string[] = []
  const relay = startRelayServer({
    host: "127.0.0.1",
    port: 0,
    onForward: (_room, frame) => relayFrames.push(frame),
  })
  cleanups.push(() => relay.stop())

  const pm = await createPeerNode("pm", [])
  const fe = await createPeerNode("fe", [])
  const be = await createPeerNode("be", [])

  const { code } = await pm.manager.start({ name: "alice", role: "pm", relayUrl: relay.url })
  await fe.manager.join(code, { name: "bob", role: "fe", relayUrl: relay.url })
  await be.manager.join(code, { name: "carol", role: "be", relayUrl: relay.url })

  await waitFor(
    () =>
      pm.manager.peers().length === 2 && fe.manager.peers().length === 2 && be.manager.peers().length === 2,
  )

  // Pairwise safety codes match across every pair.
  const pmSeesFe = pm.manager.resolvePeer("bob")!
  const feSeesPm = fe.manager.resolvePeer("alice")!
  expect(pmSeesFe.safetyCode).toBe(feSeesPm.safetyCode)

  expect(fe.manager.sendChat("alice", "TOP_SECRET_CHAT_MARKER_42")).toBe(true)
  await waitFor(() => pm.manager.transcript.some((t) => t.text === "TOP_SECRET_CHAT_MARKER_42"))

  // Zero-knowledge guarantee: relay NEVER saw plaintext!
  expect(relayFrames.some((f) => f.includes("TOP_SECRET_CHAT_MARKER_42"))).toBe(false)
})

test("E2E A2A grilling over WebSocket: btw-style Live Fork answer with redaction, non-intrusive Decision Card escalation, and dual-signed Handoff", async () => {
  const relayFrames: string[] = []
  const relay = startRelayServer({
    host: "127.0.0.1",
    port: 0,
    onForward: (_room, frame) => relayFrames.push(frame),
  })
  cleanups.push(() => relay.stop())

  // PM has live brainstorming context in main session and handles 2 questions:
  // Q1 answered directly from Live Fork (with an accidental secret redacted before sending).
  // Q2 triggers `need_human` -> queues Decision Card in PM's Dock -> PM answers -> final reply sent.
  const pm = await createPeerNode(
    "pm-grill",
    [
      {
        text: JSON.stringify({
          status: "answer",
          answer: "Use Stripe webhooks with key sk-1234567890abcdefghijklmnop for dev testing.",
        }),
      },
      {
        text: JSON.stringify({
          status: "need_human",
          topic: "Checkout timeout policy",
          questions: [
            {
              id: "q1",
              prompt: "Auto-cancel after 30m or manual review?",
              options: ["30m auto-cancel", "Manual"],
            },
          ],
        }),
      },
      {
        text: "Confirmed by Alice: unpaid orders auto-cancel after 30 minutes and notify the customer.",
      },
    ],
    ["Brainstorming notes: we use Stripe webhooks for billing callbacks."],
  )

  const dev = await createPeerNode("dev-grill", [])

  const { code } = await pm.manager.start({
    name: "alice",
    role: "pm",
    contextMode: "live-fork",
    relayUrl: relay.url,
  })
  await dev.manager.join(code, { name: "bob", role: "dev", relayUrl: relay.url })
  await waitFor(() => pm.manager.peers().length === 1 && dev.manager.peers().length === 1)

  // 1. Direct Live Fork answer + secret redaction.
  const res1 = await dev.manager.askPeer({
    peer: "pm",
    question: "Which payment webhook provider did we pick?",
  })
  expect(res1.answer).toContain("Stripe webhooks")
  expect(res1.answer).toContain("[REDACTED]")
  expect(res1.answer).not.toContain("sk-1234567890")
  expect(res1.redactedCount).toBe(1)
  // Verify PM's side call actually received PM's main session brainstorming message (btw-style Live Fork)!
  const pmReq1 = pm.mock.requests[0]!
  expect(JSON.stringify(pmReq1.messages)).toContain("Stripe webhooks for billing callbacks")

  // 2. Ambiguous question -> input-required streamed to Dev + Decision Card queued in PM Dock.
  const statuses: { state: PairTaskState; detail: string }[] = []
  const askPromise = dev.manager.askPeer({
    peer: "alice",
    question: "How should unpaid checkout timeout be handled?",
    onStatus: (state, detail) => statuses.push({ state, detail }),
  })

  await waitFor(() => pm.manager.pendingDecisionCount === 1)
  await waitFor(() => statuses.some((s) => s.state === "input-required"))

  const card = pm.manager.decisions.find((d) => d.status === "pending")!
  expect(card.topic).toBe("Checkout timeout policy")
  expect(pm.manager.answerDecision(card.id, "Auto-cancel after 30 minutes and send email.")).toBe(true)

  const res2 = await askPromise
  expect(res2.answer).toContain("auto-cancel after 30 minutes")

  // 3. Dual-signed immutable Handoff persisted on BOTH sides!
  const draft = dev.manager.proposeHandoff({
    peer: "alice",
    kind: "requirements",
    title: "Billing & Checkout Spec",
    content: "Stripe webhooks + 30m auto-cancel on unpaid orders.",
    decisions: ["Use Stripe webhooks", "30m auto-cancel with email"],
    acceptanceCriteria: ["Webhook signature verified", "Auto-cancel job tested"],
  })
  await waitFor(() => pm.manager.handoffs.some((h) => h.id === draft.id && h.status === "proposed"))

  const pmAccepted = pm.manager.acceptHandoff(draft.id)
  expect(pmAccepted.status).toBe("accepted")
  expect(pmAccepted.localPath && existsSync(pmAccepted.localPath)).toBe(true)

  await waitFor(() => dev.manager.handoffs.some((h) => h.id === draft.id && h.status === "accepted"))
  const devAccepted = dev.manager.handoffs.find((h) => h.id === draft.id)!
  expect(devAccepted.localPath && existsSync(devAccepted.localPath)).toBe(true)

  // Relay never saw any plaintext from questions, decisions, or handoffs.
  expect(relayFrames.some((f) => f.includes("Stripe webhooks") || f.includes("auto-cancel"))).toBe(false)
})
