import { type EncodeJob, encodeImage, type Payload } from "./encode.ts"

interface Job {
  resolve: (p: Payload) => void
  reject: (e: Error) => void
  job: EncodeJob
}

let worker: Worker | undefined
/** Workers cannot be used here (a runtime without them, say): encode on this thread. */
let broken = false
let loaded = false
let nextJob = 1
const jobs = new Map<number, Job>()
let workerUrl = new URL("./encode-worker.ts", import.meta.url).href

function getWorker(): Worker | undefined {
  if (worker || broken) return worker
  try {
    const w = new Worker(workerUrl)
    w.unref()
    w.onmessage = (
      e: MessageEvent<{ id: number; ok: true; payload: Payload } | { id: number; ok: false; error: string }>,
    ) => {
      loaded = true
      const job = jobs.get(e.data.id)
      if (!job) return
      jobs.delete(e.data.id)
      if (!jobs.size) w.unref()
      if (e.data.ok) job.resolve(e.data.payload)
      else job.reject(new Error(e.data.error))
    }
    const gone = () => {
      if (worker !== w) return
      worker = undefined
      w.terminate()
      if (!loaded) broken = true
      // What was waiting is encoded here when the worker never loaded; when it died on the
      // way (out of memory on a large image, say), those fail rather than risk this thread.
      const waiting = [...jobs.values()]
      jobs.clear()
      for (const job of waiting) {
        if (broken) inline(job)
        else job.reject(new Error("the image worker stopped"))
      }
    }
    w.addEventListener("error", gone)
    w.addEventListener("close", gone)
    worker = w
  } catch {
    broken = true
  }
  return worker
}

function inline(job: Job) {
  // A turn later, so what waits for it (a frame showing the alt text) goes first.
  setTimeout(() => {
    try {
      job.resolve(encodeImage(job.job))
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }, 0)
}

/**
 * Encodes an image in a worker, so decoding a large one (hundreds of milliseconds) does not
 * stall Amira's input and frames; on this thread when workers cannot run.
 */
export function encodeOffThread(job: EncodeJob): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject }
    const w = getWorker()
    if (!w) return inline(entry)
    const id = nextJob++
    jobs.set(id, entry)
    w.ref()
    // A copy goes over; the caller keeps its bytes for other sizes.
    w.postMessage({ id, job })
  })
}

/** For tests: encode with another worker module (a missing one runs inline), or reset. */
export function resetEncodeWorker(opts: { url?: string } = {}): void {
  worker?.terminate()
  worker = undefined
  broken = false
  loaded = false
  if (opts.url) workerUrl = opts.url
}
