import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// The offline preload mutates process-global homes/cwd and host test registries.
// A fresh process per file is intentional; never combine files in one Bun worker.
const root = path.resolve(import.meta.dir, "..")
const directory = await mkdtemp(path.join(tmpdir(), "project-fresh-tests-"))
const files = (await readdir(path.join(root, "test"))).filter((name) => name.endsWith(".test.ts")).sort()
const jobs = Number(process.env.PROJECT_TEST_JOBS ?? 2)
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 3) throw new Error("PROJECT_TEST_JOBS must be 1–3")
const excluded = new Set(process.argv.slice(2))
const selected = files.filter((file) => !excluded.has(file))
const results: {
  file: string
  exit: number
  pass: number
  fail: number
  skip: number
  milliseconds: number
}[] = []
let next = 0
console.log(
  `Fresh-process offline tests: ${selected.length}/${files.length} files; ${jobs} workers; logs: ${directory}`,
)
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < selected.length) {
      const file = selected[next++]!
      const started = performance.now()
      const child = Bun.spawn([process.execPath, "test", `test/${file}`, "--timeout", "240000"], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = `${stdout}\n${stderr}`
      await writeFile(path.join(directory, `${file}.log`), output)
      const count = (label: string) =>
        Number(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "m").exec(output)?.[1] ?? 0)
      const result = {
        file,
        exit,
        pass: count("pass"),
        fail: count("fail"),
        skip: count("skip"),
        milliseconds: Math.round(performance.now() - started),
      }
      results.push(result)
      console.log(
        `${exit ? "FAIL" : "PASS"} ${file}: ${result.pass} pass, ${result.fail} fail, ${result.skip} skip (${Math.round(result.milliseconds / 1000)}s)`,
      )
      if (exit) console.log(output.slice(-4000))
    }
  }),
)
results.sort((a, b) => a.file.localeCompare(b.file))
const total = {
  files: results.length,
  pass: results.reduce((n, r) => n + r.pass, 0),
  fail: results.reduce((n, r) => n + r.fail, 0),
  skip: results.reduce((n, r) => n + r.skip, 0),
  failedFiles: results.filter((r) => r.exit).map((r) => r.file),
}
await writeFile(path.join(directory, "summary.json"), JSON.stringify({ total, results }, null, 2))
console.log(JSON.stringify(total))
console.log(`Logs and summary: ${directory}`)
process.exitCode = total.failedFiles.length ? 1 : 0
