import { expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { openRepo, type Repo } from "../src/git.ts"
import { CheckpointStore, collapse, DisabledError, REF_PREFIX, type StoreLimits } from "../src/store.ts"
import { git, indexBytes, repo, run, tmp, tree, userState, write } from "./helpers.ts"

setDefaultTimeout(60_000)

async function storeFor(dir: string, limits: Partial<StoreLimits> = {}, shadow = true) {
  const home = tmp("home")
  const r = await openRepo(run, { cwd: dir, home, shadow, timeoutMs: 60_000 })
  if ("disabled" in r) throw new Error(r.disabled)
  return { store: new CheckpointStore(r, limits), repo: r as Repo, home }
}

const listTree = async (dir: string, commit: string) =>
  (await git(dir, "ls-tree", "-r", "-z", "--name-only", commit)).split("\0").filter(Boolean).sort()

const BINARY = new Uint8Array([0, 1, 2, 255, 13, 10, 0, 10, 13, 128, 0x89, 0x50, 0x4e, 0x47])

test("a checkpoint leaves the user's branch, index, stash and refs alone, and holds untracked files", async () => {
  const dir = await repo({ "a.txt": "one\n", ".gitignore": "*.log\nbuild/\n" })
  write(dir, "a.txt", "one, changed\n")
  write(dir, "staged.txt", "staged\n")
  await git(dir, "add", "staged.txt")
  write(dir, "untracked.txt", "new\n")
  write(dir, "debug.log", "ignored\n")
  write(dir, "build/out.bin", "ignored too\n")
  await git(dir, "stash", "list")
  const before = await userState(dir)
  const status = await git(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all")
  const index = indexBytes(dir)

  const { store } = await storeFor(dir)
  const { checkpoint } = await store.create("s_1", { kind: "turn", turn: 1, prompt: "hi" })
  expect(checkpoint!.ref).toBe(`${REF_PREFIX}s_1/1`)
  expect(indexBytes(dir)).toBe(index)
  expect(await userState(dir)).toEqual(before)
  expect(await git(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toBe(status)
  expect(await listTree(dir, checkpoint!.commit)).toEqual([
    ".gitignore",
    "a.txt",
    "staged.txt",
    "untracked.txt",
  ])
  expect(await git(dir, "show", `${checkpoint!.commit}:a.txt`)).toBe("one, changed\n")
  // Not a branch, not in the log, not a stash.
  expect(await git(dir, "branch", "--list")).not.toContain("amira")
  expect(await git(dir, "log", "--branches", "--format=%s")).not.toContain("amira checkpoint")
  expect((await store.list("s_1")).map((c) => [c.n, c.meta.kind, c.meta.turn, c.meta.prompt])).toEqual([
    [1, "turn", 1, "hi"],
  ])
})

test("restore brings back modified, deleted, renamed, new, binary and CRLF files byte for byte", async () => {
  const dir = await repo({
    ".gitattributes": "* text=auto eol=lf\n",
    "crlf.txt": "keep\r\nthese\r\nendings\r\n",
    "lf.txt": "plain\nlf\n",
    "sub/deep/nested.txt": "deep\n",
    "old name.txt": "renamed later\n",
  })
  // The user's settings convert line endings; a snapshot must not.
  await git(dir, "config", "core.autocrlf", "true")
  write(dir, "bin.dat", BINARY)
  write(dir, "ünïcode ñame.txt", "unicode\r\n")
  write(dir, "untracked-crlf.txt", "a\r\nb\r\n")
  const original = tree(dir)
  const before = await userState(dir)

  const { store } = await storeFor(dir)
  const first = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!

  // What a turn might do.
  write(dir, "crlf.txt", "keep\nthese\nendings\nnow lf\n")
  write(dir, "lf.txt", "plain\r\nnow crlf\r\n")
  rmSync(path.join(dir, "sub"), { recursive: true })
  renameSync(path.join(dir, "old name.txt"), path.join(dir, "new name.txt"))
  write(dir, "bin.dat", new Uint8Array([...BINARY, 7, 7]))
  write(dir, "brand/new.txt", "made by the model\n")
  rmSync(path.join(dir, "ünïcode ñame.txt"))
  const changed = tree(dir)

  const index = indexBytes(dir)
  const { safety, restored } = await store.restore("s_1", first)
  expect(indexBytes(dir)).toBe(index)
  expect(tree(dir)).toEqual(original)
  expect(restored.map((c) => `${c.status} ${c.path}`).sort()).toEqual([
    "A old name.txt",
    "A sub/deep/nested.txt",
    "A ünïcode ñame.txt",
    "D brand/new.txt",
    "D new name.txt",
    "M bin.dat",
    "M crlf.txt",
    "M lf.txt",
  ])
  // Empty directories left by removed files go too.
  expect(existsSync(path.join(dir, "brand"))).toBe(false)
  expect(await userState(dir)).toEqual(before)

  // The state before the restore was kept, and restoring it undoes the restore.
  expect(safety.meta.kind).toBe("restore")
  expect(safety.meta.note).toBe(`before restoring #${first.n}`)
  await store.restore("s_1", safety)
  expect(tree(dir)).toEqual(changed)
})

test("restoring only some paths leaves every other file as it is", async () => {
  const dir = await repo({ "a.txt": "a1\n", "b.txt": "b1\n", "dir/c.txt": "c1\n", "dir/d.txt": "d1\n" })
  const { store } = await storeFor(dir)
  const first = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!
  write(dir, "a.txt", "a2\n")
  write(dir, "b.txt", "b2\n")
  write(dir, "dir/c.txt", "c2\n")
  rmSync(path.join(dir, "dir", "d.txt"))
  write(dir, "dir/e.txt", "new\n")

  const { restored } = await store.restore("s_1", first, { paths: ["a.txt", "dir"] })
  expect(restored.map((c) => c.path).sort()).toEqual(["a.txt", "dir/c.txt", "dir/d.txt", "dir/e.txt"])
  expect(tree(dir)).toEqual(
    Object.fromEntries(
      Object.entries({ "a.txt": "a1\n", "b.txt": "b2\n", "dir/c.txt": "c1\n", "dir/d.txt": "d1\n" }).map(
        ([k, v]) => [k, Buffer.from(v).toString("hex")],
      ),
    ),
  )
})

test("each checkpoint records what changed since the one before; unchanged ones can be skipped", async () => {
  const dir = await repo()
  const { store } = await storeFor(dir)
  const one = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!
  expect(one.meta.changedCount).toBe(-1)
  write(dir, "a.txt", "two\n")
  write(dir, "x.txt", "x\n")
  const two = (await store.create("s_1", { kind: "turn", turn: 2 })).checkpoint!
  expect(two.meta.changed.sort()).toEqual(["a.txt", "x.txt"])
  expect(two.meta.changedCount).toBe(2)
  const skipped = await store.create("s_1", { kind: "tool", tool: "edit a.txt" }, { skipUnchanged: true })
  expect(skipped.checkpoint).toBeUndefined()
  // Other sessions number their own checkpoints.
  const other = (await store.create("s_2", { kind: "turn", turn: 1 })).checkpoint!
  expect(other.n).toBe(1)
  expect((await store.list()).map((c) => `${c.session}/${c.n}`)).toEqual(["s_1/1", "s_1/2", "s_2/1"])
})

test("pruning keeps the newest checkpoints of a session", async () => {
  const dir = await repo()
  const { store } = await storeFor(dir)
  for (let i = 1; i <= 5; i++) {
    write(dir, "a.txt", `v${i}\n`)
    await store.create("s_1", { kind: "turn", turn: i }, { keep: 3 })
  }
  expect((await store.list("s_1")).map((c) => c.n)).toEqual([3, 4, 5])
  // Numbers keep counting up after a prune.
  await store.create("s_1", { kind: "turn", turn: 6 }, { keep: 3 })
  expect((await store.list("s_1")).map((c) => c.n)).toEqual([4, 5, 6])
  expect(await store.pruneOlder(-1000)).toBe(3)
  expect(await store.list("s_1")).toEqual([])
})

test("large untracked files, and untracked files beyond the limit, are left out", async () => {
  const dir = await repo({ "src/a.txt": "a\n" })
  write(dir, "big.bin", new Uint8Array(2000))
  write(dir, "small.txt", "s\n")
  const { store } = await storeFor(dir, { maxFileBytes: 1000 })
  const first = await store.create("s_1", { kind: "turn", turn: 1 })
  expect(first.skipped.large).toEqual(["big.bin"])
  expect(await listTree(dir, first.checkpoint!.commit)).toEqual(["small.txt", "src/a.txt"])

  // A file that grows past the limit drops out; tracked files never do.
  write(dir, "small.txt", "x".repeat(1500))
  write(dir, "src/a.txt", "y".repeat(1500))
  const second = await store.create("s_1", { kind: "turn", turn: 2 })
  expect(second.skipped.large.sort()).toEqual(["big.bin", "small.txt"])
  expect(await listTree(dir, second.checkpoint!.commit)).toEqual(["src/a.txt"])

  const many = await storeFor(dir, { maxUntrackedFiles: 3 })
  for (let i = 0; i < 5; i++) write(dir, `gen/f${i}.txt`, `${i}\n`)
  write(dir, "src/loose.txt", "loose\n")
  const third = await many.store.create("s_1", { kind: "turn", turn: 1 })
  expect(third.skipped.untracked).toBe(8)
  expect(await listTree(dir, third.checkpoint!.commit)).toEqual(["src/a.txt"])
})

test("a file that becomes ignored drops out of later checkpoints", async () => {
  const dir = await repo({ "a.txt": "a\n" })
  write(dir, "cache.tmp", "t\n")
  const { store } = await storeFor(dir)
  const first = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!
  expect(await listTree(dir, first.commit)).toEqual(["a.txt", "cache.tmp"])
  write(dir, ".gitignore", "*.tmp\n")
  const second = (await store.create("s_1", { kind: "turn", turn: 2 })).checkpoint!
  expect(await listTree(dir, second.commit)).toEqual([".gitignore", "a.txt"])
})

test("a repository without commits works, and so does a subdirectory as the working directory", async () => {
  const dir = tmp("empty-repo")
  await git(dir, "init", "-q")
  write(dir, "pkg/one.txt", "1\n")
  const { store, repo: r } = await storeFor(path.join(dir, "pkg"))
  expect(r.mode).toBe("git")
  expect(path.resolve(r.root).toLowerCase()).toBe(path.resolve(dir).toLowerCase())
  const cp = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!
  write(dir, "pkg/one.txt", "changed\n")
  await store.restore("s_1", cp)
  expect(tree(dir)).toEqual({ "pkg/one.txt": Buffer.from("1\n").toString("hex") })
})

test("outside a repository, a shadow repository under the home directory keeps the checkpoints", async () => {
  const dir = tmp("plain")
  write(dir, "notes.md", "hello\r\n")
  write(dir, "node_modules/x/index.js", "skipped by default\n")
  const { store, repo: r, home } = await storeFor(dir)
  expect(r.mode).toBe("shadow")
  expect(r.gitDir.startsWith(home)).toBe(true)
  expect(existsSync(path.join(dir, ".git"))).toBe(false)
  const cp = (await store.create("s_1", { kind: "turn", turn: 1 })).checkpoint!
  expect((await store.changes(r.emptyTree, cp.tree)).map((c) => c.path)).toEqual(["notes.md"])
  write(dir, "notes.md", "changed\n")
  write(dir, "extra.txt", "new\n")
  await store.restore("s_1", cp)
  expect(tree(dir)).toEqual({
    "node_modules/x/index.js": Buffer.from("skipped by default\n").toString("hex"),
    "notes.md": Buffer.from("hello\r\n").toString("hex"),
  })
  expect(existsSync(path.join(dir, ".git"))).toBe(false)

  // Too many files for a directory without a repository: off, with a reason.
  write(dir, "more.txt", "more\n")
  const crowded = await storeFor(dir, { maxUntrackedFiles: 1 })
  const error = await crowded.store.create("s_1", { kind: "turn", turn: 2 }).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(DisabledError)
  expect(String(error)).toContain("holds 2 files")
  // With nonGit off there is no store at all.
  const off = await openRepo(run, { cwd: dir, home, shadow: false, timeoutMs: 60_000 })
  expect("disabled" in off && off.disabled).toContain("not a git repository")
})

test("collapse covers untracked files with the fewest paths that hold nothing tracked", () => {
  const tracked = new Set(["src/a.ts", "src/lib/b.ts", "README.md"])
  expect(
    collapse(
      ["gen/x/1.js", "gen/x/2.js", "gen/y.js", "src/new.ts", "src/lib/c.ts", "src/tmp/z.ts", "top.txt"],
      tracked,
    ).sort(),
  ).toEqual(["gen", "src/lib/c.ts", "src/new.ts", "src/tmp", "top.txt"])
})
