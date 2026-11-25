import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const WORDS = [
  "amber",
  "atlas",
  "cedar",
  "coral",
  "delta",
  "ember",
  "falcon",
  "frost",
  "harbor",
  "ivory",
  "jasper",
  "lumen",
  "maple",
  "nebula",
  "onyx",
  "orbit",
  "pearl",
  "quartz",
  "river",
  "solar",
  "spark",
  "tiger",
  "umbra",
  "velvet",
  "willow",
  "zenith",
  "prism",
  "cobalt",
  "flint",
  "grove",
  "horizon",
  "kestrel",
] as const

export interface IdentityKeys {
  peerId: string
  publicPem: string
  privateKey: KeyObject
  publicKey: KeyObject
}

export interface RoomSecret {
  code: string
  roomId: string
  authKey: Buffer
}

export interface HandshakePayload {
  kind: "hello"
  peerId: string
  identityPublicPem: string
  ephPublicPem: string
  sig: string
  roomMac: string
}

export interface EncryptedEnvelope {
  kind: "cipher"
  seq: number
  iv: string
  tag: string
  ct: string
}

export function generatePairingCode(): string {
  const num = (randomBytes(2).readUInt16BE(0) % 90) + 10
  const w1 = WORDS[randomBytes(1)[0]! % WORDS.length]!
  const w2 = WORDS[randomBytes(1)[0]! % WORDS.length]!
  return `${num}-${w1}-${w2}`
}

/** Derive an unlinkable roomId (for the zero-knowledge relay) and an authKey (never sent to relay). */
export function deriveRoomSecret(rawCode: string): RoomSecret {
  const code = rawCode.trim().toLowerCase()
  if (!code || code.length < 4) throw new Error("Pairing code is too short.")
  const master = scryptSync(code, "amira-pair-room-v1", 64, { N: 16384, r: 8, p: 1 })
  const roomId = createHash("sha256").update(master.subarray(0, 32)).digest("hex").slice(0, 32)
  const authKey = Buffer.from(master.subarray(32, 64))
  return { code, roomId, authKey }
}

/** Load or generate persistent Ed25519 identity keypair in `dataDir`. */
export function loadOrCreateIdentity(dataDir?: string): IdentityKeys {
  const file = dataDir ? path.join(dataDir, "pair-identity.json") : undefined
  if (file && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { publicPem: string; privatePem: string }
      const publicKey = createPublicKey(saved.publicPem)
      const privateKey = createPrivateKey(saved.privatePem)
      const peerId = `p_${createHash("sha256").update(saved.publicPem).digest("hex").slice(0, 12)}`
      return { peerId, publicPem: saved.publicPem, publicKey, privateKey }
    } catch {
      // Regenerate if unreadable.
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ publicPem, privatePem }, null, 2), { mode: 0o600 })
  }
  const peerId = `p_${createHash("sha256").update(publicPem).digest("hex").slice(0, 12)}`
  return { peerId, publicPem, publicKey, privateKey }
}

export function createEphemeralX25519(): { publicKey: KeyObject; privateKey: KeyObject; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  return { publicKey, privateKey, publicPem }
}

export function createSignedHello(
  identity: IdentityKeys,
  ephPublicPem: string,
  room: RoomSecret,
): HandshakePayload {
  const transcript = `amira-pair-hello-v1\n${room.roomId}\n${identity.peerId}\n${ephPublicPem}`
  const sig = sign(null, Buffer.from(transcript, "utf8"), identity.privateKey).toString("base64")
  const roomMac = createHmac("sha256", room.authKey)
    .update(`${transcript}\n${identity.publicPem}\n${sig}`)
    .digest("base64")
  return {
    kind: "hello",
    peerId: identity.peerId,
    identityPublicPem: identity.publicPem,
    ephPublicPem,
    sig,
    roomMac,
  }
}

export function verifySignedHello(hello: HandshakePayload, room: RoomSecret): boolean {
  try {
    const transcript = `amira-pair-hello-v1\n${room.roomId}\n${hello.peerId}\n${hello.ephPublicPem}`
    const expectedMac = createHmac("sha256", room.authKey)
      .update(`${transcript}\n${hello.identityPublicPem}\n${hello.sig}`)
      .digest()
    const gotMac = Buffer.from(hello.roomMac, "base64")
    if (expectedMac.length !== gotMac.length || !timingSafeEqual(expectedMac, gotMac)) return false
    const pub = createPublicKey(hello.identityPublicPem)
    if (pub.asymmetricKeyType !== "ed25519") return false
    const expectedPeerId = `p_${createHash("sha256").update(hello.identityPublicPem).digest("hex").slice(0, 12)}`
    if (expectedPeerId !== hello.peerId) return false
    return verify(null, Buffer.from(transcript, "utf8"), pub, Buffer.from(hello.sig, "base64"))
  } catch {
    return false
  }
}

/** Directional AES-256-GCM cipher with monotonic sequence numbers to block replay/reordering. */
export class PeerCipher {
  readonly safetyCode: string
  #sendKey: Buffer
  #recvKey: Buffer
  #sendSeq = 0
  #recvSeq = 0
  #aadPrefix: string

  constructor(
    localPeerId: string,
    remotePeerId: string,
    localEphPrivate: KeyObject,
    remoteEphPublicPem: string,
    room: RoomSecret,
    localIdentityPem: string,
    remoteIdentityPem: string,
  ) {
    const remoteEphPub = createPublicKey(remoteEphPublicPem)
    const shared = diffieHellman({ privateKey: localEphPrivate, publicKey: remoteEphPub })
    const orderedIds = [localPeerId, remotePeerId].sort()
    const orderedPems = [localIdentityPem, remoteIdentityPem].sort()
    const salt = createHash("sha256")
      .update(`${room.roomId}\n${orderedIds.join(":")}\n${orderedPems.join("\n")}`)
      .update(room.authKey)
      .digest()

    const kLowToHigh = Buffer.from(hkdfSync("sha256", shared, salt, "amira-pair-low-to-high", 32))
    const kHighToLow = Buffer.from(hkdfSync("sha256", shared, salt, "amira-pair-high-to-low", 32))
    const isLow = localPeerId < remotePeerId
    this.#sendKey = isLow ? kLowToHigh : kHighToLow
    this.#recvKey = isLow ? kHighToLow : kLowToHigh
    this.#aadPrefix = `${room.roomId}:${orderedIds.join(":")}`

    // Deterministic 4-word safety code identical on both peers for out-of-band check.
    const fp = Buffer.from(hkdfSync("sha256", shared, salt, "amira-pair-safety-code", 8))
    const words = [0, 2, 4, 6].map((o) => WORDS[fp.readUInt16BE(o) % WORDS.length]!)
    this.safetyCode = words.join("-")
  }

  encrypt(plaintext: string): EncryptedEnvelope {
    const seq = ++this.#sendSeq
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.#sendKey, iv)
    cipher.setAAD(Buffer.from(`${this.#aadPrefix}:${seq}`, "utf8"))
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      kind: "cipher",
      seq,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    }
  }

  decrypt(envelope: EncryptedEnvelope): string {
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= this.#recvSeq) {
      throw new Error(`Replay or out-of-order frame detected (seq ${envelope.seq} <= ${this.#recvSeq})`)
    }
    const iv = Buffer.from(envelope.iv, "base64")
    const tag = Buffer.from(envelope.tag, "base64")
    const ct = Buffer.from(envelope.ct, "base64")
    const decipher = createDecipheriv("aes-256-gcm", this.#recvKey, iv)
    decipher.setAAD(Buffer.from(`${this.#aadPrefix}:${envelope.seq}`, "utf8"))
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
    this.#recvSeq = envelope.seq
    return plain
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{24,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{24,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{24,}\b/gi,
]

/** Redact common API keys / tokens / private keys before outbound transmission. */
export function redactSecrets(input: string): { text: string; count: number } {
  let text = input
  let count = 0
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      count++
      return "[REDACTED]"
    })
  }
  return { text, count }
}
