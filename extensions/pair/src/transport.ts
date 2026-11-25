import {
  createEphemeralX25519,
  createSignedHello,
  type EncryptedEnvelope,
  type HandshakePayload,
  type IdentityKeys,
  PeerCipher,
  type RoomSecret,
  verifySignedHello,
} from "./crypto.ts"
import type { PairRpcMessage, PeerCard } from "./types.ts"

export interface PeerLink {
  peerId: string
  cipher: PeerCipher
  card?: PeerCard
}

export interface TransportCallbacks {
  onPeerReady(peerId: string, card: PeerCard, safetyCode: string): void
  onPeerLeft(peerId: string): void
  onMessage(fromPeerId: string, msg: PairRpcMessage): void
  onError(error: string): void
  onDisconnect(reason: string): void
}

/**
 * Multi-peer (2..N) E2EE WebSocket transport over a zero-knowledge relay.
 * Every pair of peers establishes an independent X25519+Ed25519+AES-256-GCM channel.
 */
export class PairTransport {
  readonly relayUrl: string
  readonly room: RoomSecret
  readonly identity: IdentityKeys
  #localCard: PeerCard
  #callbacks: TransportCallbacks
  #ws: WebSocket | undefined
  #eph = createEphemeralX25519()
  #peers = new Map<string, PeerLink>()
  #helloSentTo = new Set<string>()
  #pingTimer: ReturnType<typeof setInterval> | undefined
  #closed = false

  constructor(
    relayUrl: string,
    room: RoomSecret,
    identity: IdentityKeys,
    localCard: PeerCard,
    callbacks: TransportCallbacks,
  ) {
    this.relayUrl = relayUrl
    this.room = room
    this.identity = identity
    this.#localCard = localCard
    this.#callbacks = callbacks
  }

  get peers(): ReadonlyMap<string, PeerLink> {
    return this.#peers
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    const url = new URL(this.relayUrl)
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`Unsupported relay protocol "${url.protocol}"; expected ws: or wss:`)
    }
    url.searchParams.set("room", this.room.roomId)

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString())
      this.#ws = ws
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        ws.close()
        reject(new Error(`Timed out connecting to Pair relay (${this.relayUrl})`))
      }, timeoutMs)

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "relay.join",
            roomId: this.room.roomId,
            peerId: this.identity.peerId,
          }),
        )
      })

      ws.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : ""
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(text) as Record<string, unknown>
        } catch {
          return
        }

        if (frame.type === "relay.joined") {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve()
          }
          const existing = Array.isArray(frame.peers) ? (frame.peers as string[]) : []
          for (const remoteId of existing) {
            if (remoteId !== this.identity.peerId) this.#sendHello(remoteId)
          }
          this.#startHeartbeat()
          return
        }

        if (frame.type === "relay.error") {
          const err = typeof frame.error === "string" ? frame.error : "relay error"
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(err))
          } else {
            this.#callbacks.onError(err)
          }
          return
        }

        if (frame.type === "relay.peer_joined" && typeof frame.peerId === "string") {
          if (frame.peerId !== this.identity.peerId) this.#sendHello(frame.peerId)
          return
        }

        if (frame.type === "relay.peer_left" && typeof frame.peerId === "string") {
          this.#peers.delete(frame.peerId)
          this.#helloSentTo.delete(frame.peerId)
          this.#callbacks.onPeerLeft(frame.peerId)
          return
        }

        if (frame.type === "relay.frame" && typeof frame.from === "string" && frame.body) {
          this.#handleRelayFrame(frame.from, frame.body as HandshakePayload | EncryptedEnvelope)
        }
      })

      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`WebSocket connection failed (${this.relayUrl})`))
        } else if (!this.#closed) {
          this.#callbacks.onError("Pair relay socket error")
        }
      })

      ws.addEventListener("close", (ev) => {
        this.#stopHeartbeat()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`Pair relay closed before join (${ev.reason || ev.code})`))
        } else if (!this.#closed) {
          this.#callbacks.onDisconnect(ev.reason || `closed (${ev.code})`)
        }
      })
    })
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ type: "relay.ping" }))
      }
    }, 25_000)
  }

  #stopHeartbeat(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = undefined
    }
  }

  #sendHello(toPeerId: string): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    const hello = createSignedHello(this.identity, this.#eph.publicPem, this.room)
    this.#helloSentTo.add(toPeerId)
    this.#ws.send(JSON.stringify({ type: "relay.send", to: toPeerId, body: hello }))
  }

  #handleRelayFrame(fromPeerId: string, body: HandshakePayload | EncryptedEnvelope): void {
    if (body.kind === "hello") {
      if (body.peerId !== fromPeerId || !verifySignedHello(body, this.room)) {
        this.#callbacks.onError(`Rejected unauthenticated handshake from ${fromPeerId}`)
        return
      }
      if (!this.#helloSentTo.has(fromPeerId)) this.#sendHello(fromPeerId)
      const cipher = new PeerCipher(
        this.identity.peerId,
        fromPeerId,
        this.#eph.privateKey,
        body.ephPublicPem,
        this.room,
        this.identity.publicPem,
        body.identityPublicPem,
      )
      this.#peers.set(fromPeerId, { peerId: fromPeerId, cipher })
      this.send(fromPeerId, {
        type: "pair.card",
        card: { ...this.#localCard, safetyCode: cipher.safetyCode },
      })
      return
    }

    if (body.kind === "cipher") {
      const link = this.#peers.get(fromPeerId)
      if (!link) return
      let msg: PairRpcMessage
      try {
        const plain = link.cipher.decrypt(body)
        msg = JSON.parse(plain) as PairRpcMessage
      } catch (err) {
        this.#callbacks.onError(
          `Failed to decrypt frame from ${fromPeerId}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      if (msg.type === "pair.card") {
        link.card = { ...msg.card, peerId: fromPeerId, safetyCode: link.cipher.safetyCode }
        this.#callbacks.onPeerReady(fromPeerId, link.card, link.cipher.safetyCode)
        return
      }
      this.#callbacks.onMessage(fromPeerId, msg)
    }
  }

  send(toPeerId: string, msg: PairRpcMessage): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false
    const link = this.#peers.get(toPeerId)
    if (!link) return false
    const envelope = link.cipher.encrypt(JSON.stringify(msg))
    this.#ws.send(JSON.stringify({ type: "relay.send", to: toPeerId, body: envelope }))
    return true
  }

  close(): void {
    this.#closed = true
    this.#stopHeartbeat()
    this.#ws?.close(1000, "pair left")
    this.#ws = undefined
    this.#peers.clear()
    this.#helloSentTo.clear()
  }
}
