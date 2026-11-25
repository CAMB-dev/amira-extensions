export type PairScope = "ask-only" | "read-context" | "handoff"
export type PairContextMode = "live-fork" | "brief"
export type PairTaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled"
export type HandoffKind = "requirements" | "api-contract" | "design-notes" | "review"

export interface PeerCard {
  peerId: string
  name: string
  role: string
  scopes: PairScope[]
  contextMode: PairContextMode
  identityPublicKey: string
  safetyCode?: string
  summary?: string
}

export interface PairPeerSummary {
  peerId: string
  name: string
  role: string
  scopes: PairScope[]
  safetyCode: string
  connected: boolean
}

export interface DecisionQuestion {
  id: string
  prompt: string
  options?: string[]
  answer?: string
}

export interface DecisionCard {
  id: string
  taskId: string
  fromPeerId: string
  fromName: string
  topic: string
  questions: DecisionQuestion[]
  createdAt: number
  status: "pending" | "answered" | "declined"
}

export interface HandoffArtifact {
  id: string
  version: number
  kind: HandoffKind
  title: string
  fromPeerId: string
  fromName: string
  toPeerId: string
  toName: string
  content: string
  decisions: string[]
  openQuestions: string[]
  acceptanceCriteria: string[]
  sha256: string
  status: "proposed" | "accepted" | "changes-requested"
  changeNote?: string
  localPath?: string
  createdAt: number
  acceptedAt?: number
}

export interface PairTranscriptEntry {
  id: string
  timestamp: number
  direction: "in" | "out" | "system"
  peerName: string
  kind: "chat" | "ask" | "answer" | "status" | "handoff"
  text: string
}

export type PairRpcMessage =
  | { type: "pair.card"; card: PeerCard }
  | { type: "pair.chat"; text: string }
  | { type: "pair.task.send"; taskId: string; question: string; context?: string }
  | {
      type: "pair.task.status"
      taskId: string
      state: PairTaskState
      detail: string
      pendingCount?: number
    }
  | { type: "pair.task.complete"; taskId: string; answer: string; redactedCount?: number }
  | { type: "pair.task.error"; taskId: string; error: string }
  | { type: "pair.handoff.propose"; handoff: HandoffArtifact }
  | { type: "pair.handoff.accept"; id: string; version: number; sha256: string }
  | { type: "pair.handoff.reject"; id: string; version: number; note: string }

export interface PairAskRequest {
  peer: string
  question: string
  taskId?: string
  context?: string
  onStatus?: (state: PairTaskState, detail: string) => void
  signal?: AbortSignal
}

export interface PairAskResult {
  taskId: string
  peerName: string
  answer: string
  redactedCount: number
}

declare module "@amira/api" {
  interface AmiraServices {
    "pair.peers": () => PairPeerSummary[]
    "pair.ask": (req: PairAskRequest) => Promise<PairAskResult>
    "pair.handoffs": () => HandoffArtifact[]
  }
}
