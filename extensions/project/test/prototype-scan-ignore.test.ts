import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPrototypeScanIgnore } from "../src/prototype-scan-ignore.ts"

const temporary: string[] = []
const scans: Awaited<ReturnType<typeof createPrototypeScanIgnore>>[] = []
afterEach(async () => {
  for (const scan of scans.splice(0)) await scan.close()
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "project-prototype-ignore-"))
  temporary.push(root)
  return realpath(root)
}

async function source(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

async function git(root: string, ...args: string[]): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT(?:_|$)/i.test(key)))
  const emptyConfig = path.join(root, "absent-config")
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_TERMINAL_PROMPT: "0",
  })
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (status !== 0) throw new Error(`Fixture Git failed (${status}): ${stderr}`)
}

async function scan(root: string) {
  const result = await createPrototypeScanIgnore(root)
  scans.push(result)
  return result
}

async function environment(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, values)
    await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("uses native anchors, nested rules, directory exclusions and negations", async () => {
  const root = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(root, ".gitignore", "/root-only.ts\n*.generated.ts\ncache/\noutput/*\n!output/keep/\n")
  await source(root, "src/.gitignore", "!keep.generated.ts\n/local.ts\n")
  await source(root, ".git/info/exclude", "private.ts\n")
  const ignore = await scan(root)
  const paths = [
    "root-only.ts",
    "src/root-only.ts",
    "src/drop.generated.ts",
    "src/keep.generated.ts",
    "src/local.ts",
    "src/deep/local.ts",
    "cache/",
    "cache/file.ts",
    "src/cache/",
    "output/drop/",
    "output/keep/",
    "output/keep/file.ts",
    "private.ts",
    "visible.ts",
  ]
  expect(await ignore.ignored(paths)).toEqual(
    new Set([
      "root-only.ts",
      "src/drop.generated.ts",
      "src/local.ts",
      "cache/",
      "cache/file.ts",
      "src/cache/",
      "output/drop/",
      "private.ts",
    ]),
  )
})

test("non-Git projects use the same rules without adding project metadata", async () => {
  const root = await project()
  await source(root, ".gitignore", "/root.ts\n*.generated.ts\ncache/\noutput/*\n!output/keep/\n")
  await source(root, "src/.gitignore", "!keep.generated.ts\n/local.ts\n")
  const before = await readdir(root, { recursive: true })
  const ignore = await scan(root)
  expect(
    await ignore.ignored([
      "root.ts",
      "src/root.ts",
      "src/drop.generated.ts",
      "src/keep.generated.ts",
      "src/local.ts",
      "src/deep/local.ts",
      "cache/",
      "cache/file.ts",
      "output/drop/",
      "output/keep/",
      "output/keep/file.ts",
    ]),
  ).toEqual(
    new Set(["root.ts", "src/drop.generated.ts", "src/local.ts", "cache/", "cache/file.ts", "output/drop/"]),
  )
  await ignore.close()
  await ignore.close()
  expect(await readdir(root, { recursive: true })).toEqual(before)
  expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
    "/root.ts\n*.generated.ts\ncache/\noutput/*\n!output/keep/\n",
  )
  await expect(ignore.ignored(["root.ts"])).rejects.toThrow("advisory scan unavailable")
})

test("cleans temporary metadata when Git is missing or a later check fails", async () => {
  const root = await project()
  const scratch = await project()
  await environment({ TEMP: scratch, TMP: scratch, TMPDIR: scratch }, async () => {
    await environment({ PATH: scratch }, async () => {
      await expect(createPrototypeScanIgnore(root)).rejects.toThrow("advisory scan unavailable")
    })
    expect(await readdir(scratch)).toEqual([])
    await git(root, "init", "--quiet", "--template=")
    const ignore = await scan(root)
    await source(root, ".git/config", "this is invalid Git config\n")
    await expect(ignore.ignored(["visible.ts"])).rejects.toThrow("advisory scan unavailable")
    expect(await readdir(scratch)).toEqual([])
  })
})

test("honors the parent repository and nested project rules when scanning a subdirectory", async () => {
  const repository = await project()
  await git(repository, "init", "--quiet", "--template=")
  await source(repository, ".gitignore", "/apps/site/parent.ts\n/apps/site/negated.ts\n/shared.ts\n")
  await source(repository, ".git/info/exclude", "/apps/site/private.ts\n")
  await source(repository, "apps/site/.gitignore", "!negated.ts\n/local.ts\n")
  await source(repository, "apps/site/nested/.gitignore", "deep.ts\n")
  const ignore = await scan(path.join(repository, "apps/site"))
  expect(
    await ignore.ignored([
      "parent.ts",
      "negated.ts",
      "shared.ts",
      "private.ts",
      "local.ts",
      "nested/deep.ts",
    ]),
  ).toEqual(new Set(["parent.ts", "private.ts", "local.ts", "nested/deep.ts"]))
})

test("does not ignore tracked files or rewrite the repository index or metadata", async () => {
  const root = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(root, "tracked.ts", "tracked\n")
  await source(root, "cache/tracked.ts", "tracked child\n")
  // Only this disposable fixture index is written, before the scan; no commits.
  await git(root, "add", "--", "tracked.ts", "cache/tracked.ts")
  await source(root, ".gitignore", "*.ts\ncache/\n")
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
  const before = await Promise.all(files.map((file) => readFile(file)))
  const listing = (await readdir(root, { recursive: true })).sort()
  const ignore = await scan(root)
  expect(
    await ignore.ignored(["tracked.ts", "untracked.ts", "cache/", "cache/tracked.ts", "cache/untracked.ts"]),
  ).toEqual(new Set(["untracked.ts", "cache/untracked.ts"]))
  await ignore.close()
  expect((await readdir(root, { recursive: true })).sort()).toEqual(listing)
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before)
})

test("strips inherited Git redirects/config injection while honoring effective excludes and disabling hooks", async () => {
  const root = await project()
  const other = await project()
  const home = await project()
  await git(root, "init", "--quiet", "--template=")
  await git(other, "init", "--quiet", "--template=")
  await source(root, "tracked.ts", "tracked\n")
  await git(root, "add", "--", "tracked.ts")
  await source(root, ".gitignore", "local.ts\n")
  await source(other, ".gitignore", "visible.ts\n")
  await source(home, "exclude", "global.ts\n")
  const excludes = path.join(home, "exclude").replaceAll("\\", "/")
  await source(home, ".gitconfig", `[core]\n\texcludesFile = ${excludes}\n`)
  await source(home, "invalid-config", "not valid Git config\n")
  await source(home, "protected-index", "not a Git index; do not read or replace\n")
  await git(root, "config", "core.excludesFile", excludes)
  const hook = path.join(home, "fsmonitor").replaceAll("\\", "/")
  const marker = path.join(home, "unexpected-hook").replaceAll("\\", "/")
  await source(home, "fsmonitor", `#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`)
  await chmod(hook, 0o755)
  await git(root, "config", "core.fsmonitor", hook)
  await environment(
    {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_DIR: path.join(other, ".git"),
      GIT_COMMON_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: path.join(home, "protected-index"),
      GIT_OBJECT_DIRECTORY: other,
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG: path.join(home, "invalid-config"),
      GIT_CONFIG_GLOBAL: path.join(home, "invalid-config"),
      GIT_CONFIG_SYSTEM: path.join(home, "invalid-config"),
      GIT_CONFIG_PARAMETERS: "invalid config parameters",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: excludes,
      GIT_TRACE: path.join(home, "unexpected-trace"),
    },
    async () => {
      const ignore = await scan(root)
      expect(await ignore.ignored(["local.ts", "visible.ts", "global.ts"])).toEqual(
        new Set(["local.ts", "global.ts"]),
      )
      expect(await readFile(path.join(home, "protected-index"), "utf8")).toBe(
        "not a Git index; do not read or replace\n",
      )
      expect(await readdir(home)).not.toContain("unexpected-trace")
      expect(await readdir(home)).not.toContain("unexpected-hook")
    },
  )
})

test.each([false, true])(
  "does not follow symlink .gitignore files outside the root (Git: %s)",
  async (repo) => {
    const root = await project()
    const outside = await project()
    if (repo) await git(root, "init", "--quiet", "--template=")
    await source(outside, "rules", "hidden.ts\n")
    await mkdir(path.join(root, "nested"))
    await symlink(path.join(outside, "rules"), path.join(root, ".gitignore"), "file")
    await symlink(path.join(outside, "rules"), path.join(root, "nested/.gitignore"), "file")
    const ignore = await scan(root)
    expect(await ignore.ignored(["hidden.ts", "nested/hidden.ts"])).toEqual(new Set())
    expect(await readFile(path.join(outside, "rules"), "utf8")).toBe("hidden.ts\n")
  },
)

test("preserves exact project-relative path strings through NUL-delimited batches", async () => {
  const root = await project()
  await source(root, ".gitignore", "*.hidden.ts\nfolder name/\n")
  const ignore = await scan(root)
  const paths = [
    "--help.hidden.ts",
    'quote".hidden.ts',
    "space name.hidden.ts",
    "line\nbreak.hidden.ts",
    "café.hidden.ts",
    "folder name/",
  ]
  expect(await ignore.ignored([...paths, "visible.ts", paths[0]!])).toEqual(new Set(paths))
  expect(await ignore.ignored([])).toEqual(new Set())
  expect(await ignore.ignored(["visible.ts"])).toEqual(new Set())
})

test("does not silently fall back when repository discovery fails unexpectedly", async () => {
  const root = await project()
  const scratch = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(root, ".git/config", "not valid Git config\n")
  await environment({ TEMP: scratch, TMP: scratch, TMPDIR: scratch }, async () => {
    await expect(createPrototypeScanIgnore(root)).rejects.toThrow("advisory scan unavailable")
    expect(await readdir(scratch)).toEqual([])
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe("not valid Git config\n")
  })
})

for (const repo of [false, true]) {
  test(`honors default user excludes in an isolated home (Git: ${repo})`, async () => {
    const root = await project()
    const home = await project()
    if (repo) await git(root, "init", "--quiet", "--template=")
    await source(home, "git/ignore", "default.ts\n")
    await environment({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home }, async () => {
      const ignore = await scan(root)
      expect(await ignore.ignored(["default.ts", "visible.ts"])).toEqual(new Set(["default.ts"]))
    })
  })
}

test("honors user-configured excludes and a repository-local override", async () => {
  const root = await project()
  const home = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(home, "global-ignore", "global.ts\n")
  await source(
    home,
    ".gitconfig",
    `[core]\n\texcludesFile = ${path.join(home, "global-ignore").replaceAll("\\", "/")}\n`,
  )
  await environment({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home }, async () => {
    const ignore = await scan(root)
    expect(await ignore.ignored(["global.ts", "local.ts", "visible.ts"])).toEqual(new Set(["global.ts"]))
    await source(root, "project-ignore", "local.ts\n")
    await git(root, "config", "core.excludesFile", path.join(root, "project-ignore").replaceAll("\\", "/"))
    expect(await ignore.ignored(["global.ts", "local.ts", "visible.ts"])).toEqual(new Set(["local.ts"]))
  })
})

test("lists tracked paths beneath the selected project using NUL-delimited Git index data", async () => {
  const root = await project()
  await git(root, "init", "--quiet", "--template=")
  const paths = [
    "src/build/a.ts",
    "src/out/name with spaces.scss",
    "src/target/café.json",
    // Real quoted/control-character filenames are valid on POSIX, not Windows.
    ...(process.platform === "win32" ? [] : ['src/target/quote".json', "src/build/line\nbreak.ts"]),
  ]
  for (const file of paths) await source(root, file, "tracked\n")
  await source(root, "untracked.ts", "untracked\n")
  await git(root, "add", "--", ...paths)
  const index = await readFile(path.join(root, ".git/index"))
  const ignore = await scan(root)
  expect(await ignore.tracked()).toEqual(new Set(paths))
  expect(await readFile(path.join(root, ".git/index"))).toEqual(index)
  await ignore.close()
  await expect(ignore.tracked()).rejects.toThrow("already closed")
})

test("tracked paths are project-relative and do not include a parent repository's siblings", async () => {
  const root = await project()
  await git(root, "init", "--quiet", "--template=")
  await source(root, "apps/site/src/build/main.ts", "tracked\n")
  await source(root, "other/src/out/main.ts", "unrelated\n")
  await git(root, "add", "--", "apps/site/src/build/main.ts", "other/src/out/main.ts")
  const ignore = await scan(path.join(root, "apps/site"))
  expect(await ignore.tracked()).toEqual(new Set(["src/build/main.ts"]))
})

test("non-Git projects have no tracked paths and tracked-list failures are not silently empty", async () => {
  const root = await project()
  expect(await (await scan(root)).tracked()).toEqual(new Set())
  await git(root, "init", "--quiet", "--template=")
  const ignore = await scan(root)
  await source(root, ".git/index", "invalid index data\n")
  await expect(ignore.tracked()).rejects.toThrow("tracked-file lookup failed")
  await expect(ignore.tracked()).rejects.toThrow("already closed")
})
