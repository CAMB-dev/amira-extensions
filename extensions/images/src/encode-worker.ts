// Encodes images off Amira's main thread (see worker.ts). Imports nothing of @amira/api.
import { type EncodeJob, encodeImage } from "./encode.ts"

declare const self: Worker

self.onmessage = (e: MessageEvent<{ id: number; job: EncodeJob }>) => {
  const { id, job } = e.data
  try {
    self.postMessage({ id, ok: true, payload: encodeImage(job) })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
