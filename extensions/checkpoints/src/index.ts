import path from "node:path"
import type {
  CommandCandidate,
  CommandContext,
  ExtensionAPI,
  InterceptContext,
  UserMessage,
} from "@amira/api"
import { clip, clipDiff, files, oneLine, promptIndex, promptOf, row, time, what } from "./format.ts"
import { openRepo, type Run } from "./git.ts"
import { type CheckpointSettings, readSettings } from "./settings.ts"
import { type Checkpoint, CheckpointStore, DisabledError, type Skipped } from "./store.ts"

export { openRepo, projectName, type Repo, type Run } from "./git.ts"
export { DEFAULT_SETTINGS, MUTATING_TOOLS, readSettings } from "./settings.ts"
export * from "./store.ts"

/** Where the store comes from; tests pass their own runner. */
export interface CheckpointsOptions {
  run?: Run
}

/** The turn a top-level session is running, until its checkpoint is taken. */
interface PendingTurn {
  turnId: string
  prompt: UserMessage
  /** The checkpoint being taken; tool calls wait for it. */
  snapshot?: Promise<void>
}

const DAY = 24 * 3600_000

export function createCheckpointsExtension(options: CheckpointsOptions = {}) {
  return (api: ExtensionAPI): void => {
    const settings: CheckpointSettings = readSettings(api.settings.extensions?.checkpoints, (p) =>
      api.reportError(p),
    )
    const run: Run = options.run ?? ((argv, o) => api.runCommand(argv, o))

    let store: Promise<CheckpointStore | undefined> | undefined
    /** Why checkpoints are off here, once known. */
    let disabled: string | undefined
    const reported = new Set<string>()
    const reportOnce = (text: string) => {
      if (reported.has(text)) return
      reported.add(text)
      api.reportError(text)
    }
    const getStore = (): Promise<CheckpointStore | undefined> => {
      store ??= openRepo(run, {
        cwd: api.cwd,
        home: api.home,
        shadow: settings.nonGit === "shadow",
        timeoutMs: settings.timeoutMs,
      }).then((repo) => {
        if ("disabled" in repo) {
          disabled = repo.disabled
          return undefined
        }
        return new CheckpointStore(repo, settings)
      })
      return store
    }
    const fail = (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err)
      if (err instanceof DisabledError) disableFor(text)
      else reportOnce(`checkpoints: ${text}`)
    }
    /** Checkpoints are off for the rest of the session: no later turn scans the files again. */
    const disableFor = (reason: string) => {
      disabled = reason
      store = Promise.resolve(undefined)
      reportOnce(`checkpoints: ${reason}`)
    }

    /** Parents of sub-agent sessions, so their tool calls count for the top-level session. */
    const parents = new Map<string, string>()
    const rootOf = (id: string) => {
      let at = id
      for (let i = 0; i < 20 && parents.has(at); i++) at = parents.get(at)!
      return at
    }
    const pending = new Map<string, PendingTurn>()
    /** Turn numbers per session, and the turn each running turn got. */
    const nextTurn = new Map<string, number>()
    const turnOf = new Map<string, number>()
    /** The message that started each turn we took a checkpoint for, by turn id. */
    const prompts = new Map<string, UserMessage>()
    /** What the latest snapshot of each session left out. */
    const skippedBy = new Map<string, Skipped>()

    const numberFor = async (s: CheckpointStore, session: string): Promise<number> => {
      let n = nextTurn.get(session)
      if (n === undefined) {
        const list = await s.list(session)
        n = Math.max(0, ...list.map((c) => c.meta.turn ?? 0)) + 1
      }
      nextTurn.set(session, n + 1)
      return n
    }

    /**
     * Runs a snapshot for at most timeoutMs: the git commands it runs by then are stopped, and
     * the caller goes on without it. Never throws: a failure is reported once.
     */
    const bounded = (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
      const running = boundedRun(work)
      inflight.add(running)
      void running.finally(() => inflight.delete(running))
      return running
    }
    /** Snapshots under way; commands wait for them, so they see the newest checkpoint. */
    const inflight = new Set<Promise<void>>()
    const boundedRun = async (work: (signal: AbortSignal) => Promise<void>) => {
      const ctl = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), settings.timeoutMs)
      })
      const done = work(ctl.signal).then(
        () => "done" as const,
        (err: unknown) => {
          if (!ctl.signal.aborted) fail(err)
          return "failed" as const
        },
      )
      const outcome = await Promise.race([done, timedOut])
      clearTimeout(timer)
      if (outcome !== "timeout") return
      ctl.abort()
      reportOnce(
        `checkpoints: a snapshot took longer than ${settings.timeoutMs} ms, so a turn went on without its checkpoint`,
      )
      // Git was stopped in the middle; the lock it left on this process's index is removed by
      // the next command that needs the index.
    }

    /** Starts the turn's checkpoint once; the turn's tool calls wait for it. */
    const startTurn = (session: string, turn: PendingTurn): Promise<void> => {
      turn.snapshot ??= bounded(async (sig) => {
        const s = await getStore()
        if (!s) return
        const n = await numberFor(s, session)
        turnOf.set(turn.turnId, n)
        prompts.set(turn.turnId, turn.prompt)
        for (const k of prompts.keys()) {
          if (prompts.size <= 1000) break
          prompts.delete(k)
        }
        const { skipped } = await s.create(
          session,
          {
            kind: "turn",
            turn: n,
            turnId: turn.turnId,
            prompt: promptOf(turn.prompt),
            ...(turn.prompt.display?.origin ? { notice: true } : {}),
          },
          { signal: sig, keep: settings.keep },
        )
        noteSkipped(session, skipped)
      })
      return turn.snapshot
    }

    const noteSkipped = (session: string, skipped: Skipped) => {
      skippedBy.set(session, skipped)
      if (skipped.untracked) {
        reportOnce(
          `checkpoints: ${skipped.untracked} untracked files (over maxUntrackedFiles, ${settings.maxUntrackedFiles}) are left out of checkpoints; add them to .gitignore or raise the limit`,
        )
      }
    }

    if (settings.enabled) {
      api.on("subagent.start", (e) => void parents.set(e.data.childSessionId, e.sessionId))
      api.on("turn.start", (e) => {
        if (e.parentSessionId || !e.turnId) return
        pending.set(e.sessionId, { turnId: e.turnId, prompt: e.data.prompt })
      })
      api.on("turn.end", (e) => {
        if (pending.get(e.sessionId)?.turnId === e.turnId) pending.delete(e.sessionId)
      })
      let warmed = false
      api.on("session.start", (e) => {
        if (e.parentSessionId || warmed) return
        warmed = true
        // The first snapshot hashes every file; do it now rather than in the first turn.
        void getStore()
          .then(async (s) => {
            if (!s) return
            await s.scan()
            await s.pruneOlder(settings.maxAgeDays * DAY)
          })
          .catch(fail)
      })

      // Before the turn's first model call nothing the turn does has happened yet. The snapshot
      // runs while the model answers; the turn's tool calls wait for it.
      api.intercept(
        "context.build",
        (_value, ctx: InterceptContext) => {
          const turn = pending.get(ctx.sessionId)
          if (turn) void startTurn(ctx.sessionId, turn)
          return { action: "pass" }
        },
        { priority: -100 },
      )

      api.intercept(
        "tool.call.before",
        async (value, ctx: InterceptContext) => {
          const session = rootOf(ctx.sessionId)
          const turn = pending.get(session)
          // Started before the turn's first model call (or now, should that have been missed).
          if (turn) await startTurn(session, turn)
          if (!settings.beforeTools.includes(value.name)) return { action: "pass" }
          await bounded(async (sig) => {
            const s = await getStore()
            if (!s) return
            const n = turn ? turnOf.get(turn.turnId) : undefined
            const { skipped } = await s.create(
              session,
              {
                kind: "tool",
                tool: toolLabel(value.name, value.args),
                ...(n !== undefined ? { turn: n } : {}),
              },
              { signal: sig, skipUnchanged: true, keep: settings.keep },
            )
            noteSkipped(session, skipped)
          })
          return { action: "pass" }
        },
        // The turn's checkpoint and this call's each take at most timeoutMs.
        { priority: -100, timeoutMs: 2 * settings.timeoutMs + 5000 },
      )
    }

    /** The store, or a line saying why there is none. */
    const need = async (ctx: CommandContext): Promise<CheckpointStore | undefined> => {
      await Promise.all([...inflight])
      const s = await getStore().catch((err) => {
        fail(err)
        return undefined
      })
      if (!s) {
        ctx.print(`Checkpoints are off here: ${disabled ?? "they could not be set up"}.`, "warning")
        return undefined
      }
      return s
    }

    /** Rows of a list, newest first, each with how many files differ from it now. */
    const listLines = async (s: CheckpointStore, list: Checkpoint[]) => {
      const now = (await s.scan()).tree
      const newestFirst = [...list].reverse()
      const counts = new Map<string, number>()
      // Diffs of trees touch no index: several run at once.
      const trees = [...new Set(newestFirst.map((c) => c.tree))]
      for (let i = 0; i < trees.length; i += 8) {
        await Promise.all(
          trees.slice(i, i + 8).map(async (t) => {
            counts.set(t, t === now ? 0 : (await s.changes(t, now)).length)
          }),
        )
      }
      return newestFirst.map((c) => row(c, counts.get(c.tree)))
    }

    api.registerCommand({
      name: "checkpoints",
      description: "List this session's checkpoints (snapshots of the files before each turn)",
      args: {
        hint: "[all]",
        complete: () => [{ value: "all", description: "every session's checkpoints in this directory" }],
      },
      run: async (args, ctx) => {
        const s = await need(ctx)
        if (!s) return
        if (args.trim() === "all") {
          const all = await s.list()
          if (!all.length) return ctx.print("No checkpoints here yet.")
          const by = new Map<string, Checkpoint[]>()
          for (const c of all) by.set(c.session, [...(by.get(c.session) ?? []), c])
          const lines = [...by].map(
            ([id, cs]) =>
              `${id}  ${cs.length} checkpoint${cs.length === 1 ? "" : "s"}, the newest ${time(cs.at(-1)!.meta.ts)}`,
          )
          return ctx.print([`Checkpoints in ${s.repo.root}:`, ...lines].join("\n"))
        }
        const session = ctx.session.info().id
        const list = await s.list(session)
        if (!list.length) {
          return ctx.print(
            settings.enabled
              ? "No checkpoints in this session yet; one is taken before each turn."
              : "No checkpoints in this session (extensions.checkpoints.enabled is false).",
          )
        }
        const lines = await listLines(s, list)
        const skipped = skippedBy.get(session)
        const notes: string[] = []
        if (skipped?.large.length) notes.push(`Left out as too large: ${clip(skipped.large.join(", "), 200)}`)
        if (skipped?.untracked) notes.push(`Left out: ${skipped.untracked} untracked files (too many)`)
        ctx.print(
          [
            `Checkpoints of this session, newest first (${s.repo.mode === "shadow" ? "kept outside this directory, which is not a git repository" : "git refs under refs/amira/checkpoints"}):`,
            ...lines.map((l) => `  ${l}`),
            ...notes,
            "/rewind <n> restores one; /rewind <n> --files <paths> restores only some files.",
          ].join("\n"),
        )
      },
    })

    api.registerCommand({
      name: "rewind",
      description: "Restore the files (and optionally the conversation) to a checkpoint",
      args: {
        hint: "[n] [--files <paths>] [--conversation] [--yes]",
        complete: async (_prefix, ctx) => {
          const s = await getStore().catch(() => undefined)
          if (!s) return []
          const list = await s.list(ctx.session.info().id)
          return [...list]
            .reverse()
            .map(
              (c): CommandCandidate => ({ value: String(c.n), description: `${time(c.meta.ts)} ${what(c)}` }),
            )
        },
      },
      run: async (args, ctx) => rewind(args, ctx),
    })

    const rewind = async (args: string, ctx: CommandContext) => {
      const opts = parseRewindArgs(args)
      if ("error" in opts) throw new Error(opts.error)
      if (ctx.session.info().busy)
        throw new Error("a turn is running; rewind after it ends (or press Esc to stop it)")
      const s = await need(ctx)
      if (!s) return
      const session = ctx.session.info().id
      const list = await s.list(session)
      if (!list.length) return ctx.print("No checkpoints in this session yet; one is taken before each turn.")

      let paths: string[] | undefined
      if (opts.files) {
        paths = []
        for (const p of opts.files) {
          const rel = path.relative(s.repo.root, path.resolve(ctx.cwd, p))
          if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
            throw new Error(`${p} is outside ${s.repo.root}`)
          paths.push(rel.split(path.sep).join("/"))
        }
        if (!paths.length) throw new Error("--files needs at least one path")
        if (paths.includes("")) paths = []
      }

      let target: Checkpoint | undefined
      if (opts.n !== undefined) {
        target = list.find((c) => c.n === opts.n)
        if (!target) throw new Error(`no checkpoint #${opts.n} in this session; /checkpoints lists them`)
      } else {
        const rows = await listLines(s, list)
        const newestFirst = [...list].reverse()
        const picked = await ctx.ui.select(
          paths?.length
            ? `Restore ${paths.join(", ")} from which checkpoint?`
            : "Rewind to which checkpoint?",
          rows,
          { signal: ctx.signal },
        )
        if (picked === undefined) {
          if (ctx.frontend === "tui") return ctx.print("Nothing restored.")
          return ctx.print(
            [
              "Checkpoints, newest first:",
              ...rows.map((r) => `  ${r}`),
              "Run /rewind <n> [--yes] to restore one.",
            ].join("\n"),
          )
        }
        target = newestFirst[rows.indexOf(picked)]
        if (!target) return ctx.print("Nothing restored.")
      }

      const now = await s.scan()
      const changes = await s.changes(now.tree, target.tree, paths ?? [])
      const canCut =
        !paths &&
        target.meta.kind === "turn" &&
        target.session === session &&
        ctx.session.rewind !== undefined
      const index = canCut ? promptIndex(ctx.session.messages(), target, list, prompts) : undefined
      const turn = target.meta.turn
      const restoreLabel = `Restore ${files(changes.length)}`
      const bothLabel = changes.length
        ? `Restore ${files(changes.length)} and rewind the conversation to before turn ${turn}`
        : `Rewind the conversation to before turn ${turn} (the files already match)`
      const choices: string[] = []
      if (changes.length) choices.push(restoreLabel)
      if (index !== undefined) choices.push(bothLabel)
      if (!choices.length) {
        const why =
          opts.conversation && !paths
            ? target.meta.kind !== "turn"
              ? "; only a checkpoint taken before a turn can take the conversation back"
              : !ctx.session.rewind
                ? "; this Amira cannot rewind the conversation"
                : "; its turn is no longer in the conversation"
            : ""
        return ctx.print(
          `The files already match checkpoint #${target.n}${paths?.length ? ` for ${paths.join(", ")}` : ""}; nothing to restore${why}.`,
        )
      }

      let choice: string | undefined
      if (opts.yes) {
        choice = opts.conversation
          ? index !== undefined
            ? bothLabel
            : undefined
          : changes.length
            ? restoreLabel
            : undefined
        if (!choice) {
          throw new Error(
            opts.conversation
              ? "the conversation cannot be rewound to this checkpoint; leave out --conversation to restore the files only"
              : "the files already match; add --conversation to rewind the conversation",
          )
        }
      } else {
        const title = `Rewind to #${target.n} (${time(target.meta.ts)}, ${what(target, 50)})?`
        const options = [...choices, "Cancel"]
        const diff = changes.length ? await s.diff(now.tree, target.tree, paths ?? []) : ""
        choice = diff.trim()
          ? await ctx.ui.reviewDiff(title, clipDiff(diff), options, { signal: ctx.signal })
          : await ctx.ui.select(title, options, { signal: ctx.signal })
        if (choice === undefined && ctx.frontend !== "tui") {
          return ctx.print(
            `Nobody could confirm; run /rewind ${target.n}${paths ? ` --files ${opts.files!.join(" ")}` : ""} --yes to restore without asking.`,
            "warning",
          )
        }
      }
      if (!choice || choice === "Cancel") return ctx.print("Nothing restored.")
      // A turn may have started while the dialog was open (a background result woke the session).
      if (ctx.session.info().busy) {
        throw new Error("a turn started meanwhile; nothing was restored. Rewind after it ends")
      }

      const out: string[] = []
      let warn = false
      if (changes.length) {
        const r = await s.restore(session, target, {
          ...(paths ? { paths } : {}),
          ...(turn !== undefined ? { turn } : {}),
          keep: settings.keep + 1,
        })
        const names = (list: string[]) => clip(list.join(", "), 300)
        if (r.restored.length || !(r.failed.length || r.left.length)) {
          out.push(
            `Restored ${files(r.restored.length)} from checkpoint #${target.n}: ${names(r.restored.map((c) => c.path))}`,
          )
        }
        if (r.failed.length) {
          warn = true
          out.push(
            `Could not restore ${files(r.failed.length)} (open in another program?): ${names(r.failed)}${r.error ? ` (git: ${clip(r.error, 200)})` : ""}`,
          )
        }
        if (r.left.length) {
          warn = true
          out.push(
            `Left as they are: ${names(r.left)}. What is there now is in no checkpoint (ignored or too large), and too large to keep before replacing it.`,
          )
        }
        out.push(
          `The files as they were are checkpoint #${r.safety.n}${r.kept.length ? ` (with ${names(r.kept)}, which no checkpoint held before)` : ""}; /rewind ${r.safety.n} goes back to them.`,
        )
      }
      if (choice === bothLabel && index !== undefined) {
        try {
          await ctx.session.rewind!(index)
          if (turn !== undefined) nextTurn.set(session, turn)
          out.push(
            `The conversation is back to before turn ${turn}. Its message was: “${clip(oneLine(target.meta.prompt ?? ""), 200)}”`,
          )
          if (ctx.frontend === "tui") {
            out.push("The turns shown above from there on stay on screen, but the model no longer sees them.")
          }
        } catch (err) {
          out.push(`The conversation was not rewound: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      ctx.print(out.join("\n"), warn ? "warning" : undefined)
    }
  }
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const target = args.path ?? args.file_path ?? args.file ?? args.command
  return typeof target === "string" ? `${name} ${clip(oneLine(target), 60)}` : name
}

export interface RewindArgs {
  n?: number
  files?: string[]
  conversation: boolean
  yes: boolean
}

/** `/rewind [n] [--files <paths>] [--conversation] [--yes]`; paths may be quoted. */
export function parseRewindArgs(args: string): RewindArgs | { error: string } {
  const tokens = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")
  const out: RewindArgs = { conversation: false, yes: false }
  let inFiles = false
  for (const t of tokens) {
    if (t === "--files") {
      inFiles = true
      out.files ??= []
    } else if (t === "--yes" || t === "-y") {
      out.yes = true
      inFiles = false
    } else if (t === "--conversation") {
      out.conversation = true
      inFiles = false
    } else if (inFiles) out.files!.push(t)
    else if (/^#?\d+$/.test(t) && out.n === undefined) out.n = Number(t.replace("#", ""))
    else return { error: `unexpected "${t}"; usage: /rewind [n] [--files <paths>] [--conversation] [--yes]` }
  }
  if (out.files && out.conversation) return { error: "--files restores files only; leave out --conversation" }
  return out
}

export default createCheckpointsExtension()
