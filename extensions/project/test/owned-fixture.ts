import type { ConversationSpec, ConversationUsageSnapshot, OwnedConversation } from "@amira/api"

export function zeroUsage(id: string): ConversationUsageSnapshot {
  const value = {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    knownCostUsd: 0,
    complete: true,
  }
  return { sessionId: id, revision: 0, own: value, total: value, descendants: [] }
}
export function ownedFixture(
  spec: Pick<ConversationSpec, "key" | "cwd">,
  id = "native-design",
): OwnedConversation {
  return {
    id,
    key: spec.key,
    cwd: spec.cwd,
    name: "Fixture owner",
    data: { append() {}, read: () => [] },
    history: () => [],
    usage: () => zeroUsage(id),
    status: () => ({ state: "idle", busy: false }),
    events: { async *[Symbol.asyncIterator]() {} },
    send: async () => {},
    runTool: async () => {
      throw new Error("Unexpected tool")
    },
    complete: async () => {
      throw new Error("Unexpected generation")
    },
    stop: async () => {},
    release: async () => {},
    createGroup: () => {
      throw new Error("Unexpected group")
    },
  }
}
