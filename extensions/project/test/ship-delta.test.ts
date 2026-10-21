import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { quote, type Shell } from "../src/iteration-git.ts"
import { incomingShipDelta, reviewShipDelta, shipPathAllowed } from "../src/ship-delta.ts"
import type { ShipCheckout, ShipGitPin } from "../src/ship-git.ts"
import { ownedFixture } from "./owned-fixture.ts"

setDefaultTimeout(120_000)
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function fixture(shell: Shell = "bash") {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "ship delta's-")))
  homes.push(home)
  const repo = path.join(home, "repo")
  await mkdir(repo)
  const gitPath = Bun.which("git")!
  const bash =
    process.platform === "win32"
      ? (["../bin/bash.exe", "../../usr/bin/bash.exe", "../usr/bin/bash.exe"]
          .map((part) => path.resolve(path.dirname(gitPath), part))
          .find(existsSync) ?? "bash")
      : "bash"
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  const config = path.join(home, "empty-gitconfig")
  const template = path.join(home, "template")
  await writeFile(config, "")
  await mkdir(template)
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_SSH_COMMAND: "false",
    GIT_TEMPLATE_DIR: template,
  })
  const commands: string[] = []
  async function execute(command: string, kind: Shell = "bash") {
    const child = Bun.spawn(
      kind === "bash"
        ? [bash, "-c", command]
        : ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: repo,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      content: [{ type: "text" as const, text: stdout + stderr }],
      details: { exitCode },
      isError: exitCode !== 0,
    }
  }
  const q = (value: string) => quote(value, "bash")
  async function git(args: string, root = repo) {
    const result = await execute(`git -C ${q(root)} ${args}`)
    if (result.isError) throw new Error(result.content[0]!.text)
    return result.content[0]!.text.trim()
  }
  async function write(name: string, value: string, root = repo) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), value)
  }
  await git("init -b main")
  await git('config user.name "Offline Delta Fixture"')
  await git('config user.email "delta@invalid.local"')
  await write("approved.txt", "base\n")
  await write("unrelated.txt", "base\n")
  await write("deleted.txt", "base\n")
  await git("add -A")
  await git('commit -m "base"')
  const base = await git("rev-parse HEAD")
  const root = path.join(home, "iteration")
  await git(`worktree add -b iteration ${q(root)}`)
  const handle = ownedFixture({ key: "ship-delta-fixture", cwd: root })
  handle.runTool = async (name, args, options) => {
    if (options?.signal?.aborted)
      return { content: [], isError: true, details: { exitCode: null, aborted: true } }
    if (name !== shell) throw new Error("Unexpected tool")
    commands.push(String(args.command))
    return execute(String(args.command), shell)
  }
  async function checkout(directory: string): Promise<ShipCheckout> {
    return {
      root: directory,
      branch: await git("symbolic-ref --short HEAD", directory),
      head: await git("rev-parse HEAD", directory),
      common: path.join(repo, ".git"),
      gitDir: await git("rev-parse --absolute-git-dir", directory),
      identity: "isolated-fixture",
    }
  }
  async function pin(): Promise<ShipGitPin> {
    return {
      source: await checkout(root),
      target: await checkout(repo),
      worktree: {
        kind: "iteration-worktree",
        status: "ready",
        repository: repo,
        root,
        cwd: root,
        branch: "iteration",
        base,
        excluded: "",
        confirmation: "Fixture",
        setupKey: "ship-delta-fixture",
      },
    }
  }
  async function commit() {
    await git("add -A", root)
    await git('commit -m "prior iteration work"', root)
  }
  // Same exact candidate seam as production: HEAD plus selected working files, never the real index.
  async function candidate(selected = ["approved.txt"]) {
    const index = path.join(home, "candidate-index")
    await rm(index, { force: true })
    const result = await execute(
      `cd ${q(root)} && export GIT_INDEX_FILE=${q(index)}; git -C ${q(root)} read-tree HEAD && git -C ${q(root)} --literal-pathspecs add -A -- ${selected.map(q).join(" ")} && git -C ${q(root)} write-tree`,
    )
    if (result.isError) throw new Error(result.content[0]!.text)
    return result.content[0]!.text.trim()
  }
  return { home, repo, root, base, git, write, pin, commit, candidate, handle, commands }
}

test("rejects a precommitted prototype hidden in HEAD even when explicitly reviewed", async () => {
  const f = await fixture()
  await f.write("nested/prototypes/draft.ts", "export const draft = true\n", f.root)
  await f.commit()
  await f.write("approved.txt", "reviewed\n", f.root)
  const pin = await f.pin()
  const tree = await f.candidate()
  const before = await f.git("rev-parse HEAD", f.root)
  await expect(reviewShipDelta(f.handle, "bash", pin, tree, ["approved.txt"])).rejects.toThrow(
    /forbidden.*nested\/prototypes\/draft\.ts/is,
  )
  await expect(
    reviewShipDelta(f.handle, "bash", pin, tree, ["approved.txt", "nested/prototypes/draft.ts"]),
  ).rejects.toThrow(/forbidden/i)
  expect(await f.git("rev-parse HEAD", f.root)).toBe(before)
})

test("source-only add/delete and reverted history cannot hide forbidden or unreviewed paths", async () => {
  const f = await fixture()
  await f.write("prototypes/removed.ts", "prototype in delivered history\n", f.root)
  await f.write("unrelated.txt", "temporarily changed\n", f.root)
  await f.commit()
  await f.git("rm prototypes/removed.ts", f.root)
  await f.write("unrelated.txt", "base\n", f.root)
  await f.commit()
  const pin = await f.pin()
  const tree = await f.git("rev-parse HEAD^{tree}", f.root)
  const incoming = await incomingShipDelta(f.handle, "bash", pin, tree)
  expect(incoming.paths).toContain("prototypes/removed.ts")
  expect(incoming.paths).toContain("unrelated.txt")
  await expect(reviewShipDelta(f.handle, "bash", pin, tree, incoming.paths)).rejects.toThrow(
    "Forbidden incoming",
  )
  expect(await f.git("rev-parse HEAD", f.root)).toBe(pin.source.head)
})

test("lists every precommitted unrelated delta path missing explicit review", async () => {
  const f = await fixture()
  await f.write("unrelated.txt", "prior committed change\n", f.root)
  await f.write("other.txt", "prior committed addition\n", f.root)
  await f.commit()
  await f.write("approved.txt", "reviewed\n", f.root)
  await expect(
    reviewShipDelta(f.handle, "bash", await f.pin(), await f.candidate(), ["approved.txt"]),
  ).rejects.toThrow(/unreviewed.*other\.txt.*unrelated\.txt/is)
})

test("explicit complete review succeeds, including a previously committed deletion", async () => {
  const f = await fixture()
  await rm(path.join(f.root, "deleted.txt"))
  await f.write("unrelated.txt", "prior committed change\n", f.root)
  await f.commit()
  await f.write("approved.txt", "reviewed\n", f.root)
  const pin = await f.pin()
  const result = await reviewShipDelta(f.handle, "bash", pin, await f.candidate(), [
    "unrelated.txt",
    "deleted.txt",
    "approved.txt",
  ])
  expect(result).toEqual({ base: f.base, paths: ["approved.txt", "deleted.txt", "unrelated.txt"] })
  expect(await f.git("rev-parse HEAD", f.root)).toBe(pin.source.head)
})

test("dirty unrelated and forbidden excluded changes do not enter the exact candidate", async () => {
  const f = await fixture()
  await f.write("approved.txt", "reviewed\n", f.root)
  await f.write("unrelated.txt", "staged but excluded\n", f.root)
  await f.write("prototypes/draft.ts", "excluded draft\n", f.root)
  await f.write(".env.local", "OFFLINE_FIXTURE=not-a-secret\n", f.root)
  await f.git("add -A", f.root)
  const gitDir = await f.git("rev-parse --absolute-git-dir", f.root)
  const before = await readFile(path.join(gitDir, "index"))
  const result = await reviewShipDelta(f.handle, "bash", await f.pin(), await f.candidate(), ["approved.txt"])
  expect(result).toEqual({ base: f.base, paths: ["approved.txt"] })
  expect(await readFile(path.join(gitDir, "index"))).toEqual(before)
})

test("incoming listing uses the pinned integration target merge-base, not the iteration setup base", async () => {
  const f = await fixture()
  await f.write("target-only.txt", "target change\n")
  await f.git("add -A")
  await f.git('commit -m "target advances"')
  await f.git("merge --ff-only main", f.root)
  const expectedBase = await f.git("rev-parse HEAD")
  await f.write("approved.txt", "reviewed\n", f.root)
  const pin = await f.pin()
  const result = await incomingShipDelta(f.handle, "bash", pin, await f.candidate())
  expect(result).toEqual({ base: expectedBase, paths: ["approved.txt"] })
  expect(
    f.commands.some((command) => command.includes(`merge-base '${pin.source.head}' '${pin.target.head}'`)),
  ).toBe(true)
})

test("byte-safe listing preserves quoted Unicode and whitespace paths and includes both rename sides", async () => {
  const f = await fixture()
  const name = "new 'quoted' $(file) café  file.txt"
  await f.git(`mv deleted.txt ${quote(name, "bash")}`, f.root)
  await f.commit()
  const pin = await f.pin()
  const tree = await f.git("rev-parse HEAD^{tree}", f.root)
  expect(await incomingShipDelta(f.handle, "bash", pin, tree)).toEqual({
    base: f.base,
    paths: ["deleted.txt", name],
  })
  await expect(reviewShipDelta(f.handle, "bash", pin, tree, [name])).rejects.toThrow(
    /unreviewed.*deleted\.txt/is,
  )
  expect(await reviewShipDelta(f.handle, "bash", pin, tree, [name, "deleted.txt"])).toEqual({
    base: f.base,
    paths: ["deleted.txt", name],
  })
})

test("PowerShell preserves the native NUL-delimited Unicode delta without text redirection", async () => {
  const f = await fixture("powershell")
  const name = "new 'quoted' $(file) café.txt"
  await f.write(name, "reviewed\n", f.root)
  const pin = await f.pin()
  const tree = await f.candidate([name])
  expect(await reviewShipDelta(f.handle, "powershell", pin, tree, [name])).toEqual({
    base: f.base,
    paths: [name],
  })
})

test("rejects precommitted secret and project control-plane deltas even with complete review", async () => {
  const f = await fixture()
  const names = ["nested/.env.local", "credentials.json", ".amira/project/iterations/1/state.json"]
  for (const name of names) await f.write(name, "offline fixture\n", f.root)
  await f.commit()
  const pin = await f.pin()
  const tree = await f.git("rev-parse HEAD^{tree}", f.root)
  for (const name of names) {
    await expect(reviewShipDelta(f.handle, "bash", pin, tree, names)).rejects.toThrow(name)
  }
})

test("shared path predicate rejects secret, prototype, control-plane and unsafe paths", () => {
  for (const name of [
    ".env",
    ".env.local",
    "nested/.envrc",
    "id_rsa",
    "nested/ID_ED25519",
    "credentials",
    "credentials.json",
    "credentials-backup",
    "prototypes/draft.ts",
    "nested/Prototypes/draft.ts",
    ".amira/project/state.json",
    "nested/.AMIRA/PROJECT/state.json",
    ".amira/project",
    "../file",
    "/absolute",
    "a\\b",
    "a\0b",
    "a\nb",
    "a:b",
    "a/.git/config",
    "",
  ])
    expect(shipPathAllowed(name)).toBe(false)
  for (const name of [
    "src/file.ts",
    "test/file.test.ts",
    "prototype.ts",
    "docs/environment.md",
    ".amira/notes.md",
  ])
    expect(shipPathAllowed(name)).toBe(true)
})

test("aborted attributed Git calls fail closed", async () => {
  const f = await fixture()
  const pin = await f.pin()
  const tree = await f.git("rev-parse HEAD^{tree}", f.root)
  await expect(reviewShipDelta(f.handle, "bash", pin, tree, [], AbortSignal.abort())).rejects.toThrow(
    /Command stopped/,
  )
})
