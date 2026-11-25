/**
 * Zero-knowledge WebSocket relay for Amira Pair.
 * Routes opaque frames between peers inside a roomId; never inspects or stores plaintext.
 *
 * Run standalone:
 *   bun relay/server.ts --port 8787 --host 0.0.0.0
 */
import type { Server, ServerWebSocket } from "bun"

export interface RelayOptions {
  host?: string
  port?: number
  maxPeersPerRoom?: number
  maxFrameBytes?: number
  /** Optional observer hook (used by tests to verify relay only sees ciphertext). */
  onForward?: (roomId: string, rawFrame: string) => void
}

interface ClientData {
  roomId: string
  peerId: string
  joined: boolean
}

export interface RunningRelay {
  server: Server<ClientData>
  url: string
  port: number
  stop(): void
}

const DEFAULT_MAX_PEERS = 12
const DEFAULT_MAX_BYTES = 512 * 1024

export function startRelayServer(opts: RelayOptions = {}): RunningRelay {
  const maxPeers = opts.maxPeersPerRoom ?? DEFAULT_MAX_PEERS
  const maxBytes = opts.maxFrameBytes ?? DEFAULT_MAX_BYTES
  const rooms = new Map<string, Map<string, ServerWebSocket<ClientData>>>()

  const server = Bun.serve<ClientData>({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return new Response("ok")
      const upgraded = srv.upgrade(req, {
        data: { roomId: "", peerId: "", joined: false },
      })
      if (upgraded) return undefined
      return new Response("Amira Pair Zero-Knowledge Relay", { status: 200 })
    },
    websocket: {
      maxPayloadLength: maxBytes,
      idleTimeout: 120,
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
          ws.close(1009, "Frame too large")
          return
        }
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(text) as Record<string, unknown>
        } catch {
          return
        }

        if (msg.type === "relay.join") {
          const roomId = typeof msg.roomId === "string" ? msg.roomId : ""
          const peerId = typeof msg.peerId === "string" ? msg.peerId : ""
          if (!/^[a-f0-9]{16,64}$/.test(roomId) || !/^[a-zA-Z0-9_-]{4,64}$/.test(peerId)) {
            ws.send(JSON.stringify({ type: "relay.error", error: "invalid room or peer id" }))
            return
          }
          let room = rooms.get(roomId)
          if (!room) {
            room = new Map()
            rooms.set(roomId, room)
          }
          if (!room.has(peerId) && room.size >= maxPeers) {
            ws.send(JSON.stringify({ type: "relay.error", error: "room is full" }))
            return
          }
          // Replace stale socket if same peerId reconnects.
          room.get(peerId)?.close(1000, "reconnected")
          ws.data.roomId = roomId
          ws.data.peerId = peerId
          ws.data.joined = true
          const existingPeers = [...room.keys()]
          room.set(peerId, ws)
          ws.send(JSON.stringify({ type: "relay.joined", roomId, peers: existingPeers }))
          const notice = JSON.stringify({ type: "relay.peer_joined", peerId })
          for (const [id, peerWs] of room) {
            if (id !== peerId) peerWs.send(notice)
          }
          return
        }

        if (msg.type === "relay.ping") {
          ws.send(JSON.stringify({ type: "relay.pong" }))
          return
        }

        if (!ws.data.joined) return
        const room = rooms.get(ws.data.roomId)
        if (!room) return

        // Enforce sender identity on forwarded opaque frames.
        if (msg.type === "relay.send") {
          const to = typeof msg.to === "string" ? msg.to : "*"
          const forward = JSON.stringify({
            type: "relay.frame",
            from: ws.data.peerId,
            to,
            body: msg.body,
          })
          opts.onForward?.(ws.data.roomId, forward)
          if (to === "*") {
            for (const [id, peerWs] of room) {
              if (id !== ws.data.peerId) peerWs.send(forward)
            }
          } else {
            room.get(to)?.send(forward)
          }
        }
      },
      close(ws) {
        if (!ws.data.joined) return
        const room = rooms.get(ws.data.roomId)
        if (!room) return
        if (room.get(ws.data.peerId) === ws) {
          room.delete(ws.data.peerId)
          const left = JSON.stringify({ type: "relay.peer_left", peerId: ws.data.peerId })
          for (const peerWs of room.values()) peerWs.send(left)
          if (room.size === 0) rooms.delete(ws.data.roomId)
        }
      },
    },
  })

  const port = server.port ?? opts.port ?? 0
  const host = opts.host === "0.0.0.0" ? "127.0.0.1" : (opts.host ?? "127.0.0.1")
  return {
    server,
    port,
    url: `ws://${host}:${port}`,
    stop() {
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  let host = "0.0.0.0"
  let port = 8787
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === "--port" && process.argv[i + 1]) port = Number.parseInt(process.argv[++i]!, 10)
    else if (arg === "--host" && process.argv[i + 1]) host = process.argv[++i]!
  }
  const relay = startRelayServer({ host, port })
  console.log(`Amira Pair zero-knowledge relay listening on ws://${host}:${relay.port}`)
}
