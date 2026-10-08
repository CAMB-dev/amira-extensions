import { createHmac, timingSafeEqual } from "node:crypto"

interface Identity {
  Pid: number
  Started: string
}

interface LaunchJournal {
  OwnershipVersion: 3
  Nonce: string
  StatePath: string
  Helper: Identity
  Processes: Identity[]
  Jobs: string[]
}

/** Same exact UTF-8 Content bytes as the PowerShell codec; never reserialize before verifying. */
export function readLaunchJournal(
  serialized: string,
  key: Uint8Array,
  nonce: string,
  statePath: string,
): LaunchJournal {
  try {
    const envelope = JSON.parse(serialized)
    if (
      key.length !== 32 ||
      typeof nonce !== "string" ||
      !/^[0-9a-f-]{36}$/.test(nonce) ||
      typeof statePath !== "string" ||
      !statePath ||
      typeof envelope.Content !== "string" ||
      typeof envelope.Mac !== "string"
    )
      throw new Error()
    const expected = createHmac("sha256", key).update(envelope.Content, "utf8").digest()
    const actual = Buffer.from(envelope.Mac, "base64")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
    const state = JSON.parse(envelope.Content) as LaunchJournal
    if (
      state.OwnershipVersion !== 3 ||
      state.Nonce !== nonce ||
      state.StatePath !== statePath ||
      !Array.isArray(state.Processes) ||
      !Array.isArray(state.Jobs) ||
      ![state.Helper, ...state.Processes].every(
        (identity) =>
          identity &&
          Number.isInteger(identity.Pid) &&
          identity.Pid > 0 &&
          identity.Pid <= 2147483647 &&
          typeof identity.Started === "string" &&
          /^[1-9]\d*$/.test(identity.Started),
      ) ||
      !state.Jobs.every((name) => /^amira-uia-job-[0-9a-f-]{36}$/.test(name))
    )
      throw new Error()
    return state
  } catch {
    throw new Error("untrusted launch journal; cleanup refused")
  }
}
