/**
 * Cloudflare Worker + Durable Object deployment entry for the Amira Pair zero-knowledge relay.
 * Routes opaque encrypted frames by roomId; never inspects or persists plaintext.
 */

interface CfWebSocket extends WebSocket {
  accept(): void
}

interface CfDurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(req: Request): Promise<Response> }
}

interface Env {
  PAIR_ROOMS: CfDurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const room = url.searchParams.get("room") ?? "lobby"
    const id = env.PAIR_ROOMS.idFromName(room)
    return env.PAIR_ROOMS.get(id).fetch(request)
  },
}

export class PairRoomDO {
  #peers = new Map<string, CfWebSocket>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Amira Pair Relay Durable Object", { status: 200 })
    }
    const pair = new (
      globalThis as unknown as { WebSocketPair: new () => [CfWebSocket, CfWebSocket] }
    ).WebSocketPair()
    const [client, server] = pair
    server.accept()
    let peerId = ""

    server.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : ""
      if (text.length > 512 * 1024) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(text) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type === "relay.join" && typeof msg.peerId === "string" && typeof msg.roomId === "string") {
        peerId = msg.peerId
        const existing = [...this.#peers.keys()]
        this.#peers.set(peerId, server)
        server.send(JSON.stringify({ type: "relay.joined", roomId: msg.roomId, peers: existing }))
        const joined = JSON.stringify({ type: "relay.peer_joined", peerId })
        for (const [id, ws] of this.#peers) {
          if (id !== peerId) ws.send(joined)
        }
      } else if (msg.type === "relay.ping") {
        server.send(JSON.stringify({ type: "relay.pong" }))
      } else if (msg.type === "relay.send" && peerId) {
        const to = typeof msg.to === "string" ? msg.to : "*"
        const frame = JSON.stringify({ type: "relay.frame", from: peerId, to, body: msg.body })
        if (to === "*") {
          for (const [id, ws] of this.#peers) {
            if (id !== peerId) ws.send(frame)
          }
        } else {
          this.#peers.get(to)?.send(frame)
        }
      }
    })

    server.addEventListener("close", () => {
      if (peerId && this.#peers.get(peerId) === server) {
        this.#peers.delete(peerId)
        const left = JSON.stringify({ type: "relay.peer_left", peerId })
        for (const ws of this.#peers.values()) ws.send(left)
      }
    })

    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }
}
