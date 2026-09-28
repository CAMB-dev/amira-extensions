import path from "node:path"
import type { PackageCommandContext } from "@amira/api"
import type { McpTool, ToolOutcome } from "./server.ts"

export interface RunDefaults {
  /** Model used when a call names none; unset leaves it to Amira's settings. */
  model?: string
  cwd: string
  timeoutMs: number
}

/**
 * `amira_run`: one prompt in a fresh (or resumed) Amira session, run as `amira -p --json`
 * in a child process so every call is isolated and uses the user's settings, extensions
 * and API keys as they are.
 */
export function amiraRunTool(ctx: PackageCommandContext, defaults: RunDefaults): McpTool {
  return {
    name: "amira_run",
    description:
      "Delegate a task to Amira, a coding agent with file, search and shell tools, working in a " +
      "directory. Returns its final reply and a sessionId; pass the sessionId again to continue " +
      "the same conversation. Cheaper models are a good fit for well-specified tasks.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task or question for Amira." },
        model: {
          type: "string",
          description: `Model as provider/model.${defaults.model ? ` Default ${defaults.model}.` : ""}`,
        },
        cwd: {
          type: "string",
          description: `Working directory; a relative path is taken from ${defaults.cwd}, the default.`,
        },
        sessionId: { type: "string", description: "Continue this earlier amira_run session." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    call: (args, signal) => runAmira(ctx, defaults, args, signal),
  }
}

export async function runAmira(
  ctx: PackageCommandContext,
  defaults: RunDefaults,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const prompt = args.prompt
  if (typeof prompt !== "string" || !prompt.trim()) return { text: "prompt must be a non-empty string", isError: true }
  const model = typeof args.model === "string" && args.model ? args.model : defaults.model
  // Resolved once here: the child starts in it and also gets it as -C, so a relative
  // path would otherwise be applied twice.
  const cwd = path.resolve(defaults.cwd, typeof args.cwd === "string" && args.cwd ? args.cwd : ".")
  const session = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : undefined
  if (session && !/^s_[\w-]+$/.test(session)) return { text: `not a session id: ${session}`, isError: true }
  const argv = [
    ...ctx.amiraArgv,
    "-p",
    "--json",
    "-C",
    cwd,
    ...(model ? ["-m", model] : []),
    ...(session ? ["--resume", session] : []),
    "--",
    prompt,
  ]
  // stderr is kept: startup failures (bad model, missing key, unknown session) are only
  // reported there. In JSON mode Amira writes little else to it, and readEvents skips it.
  const run = await ctx.runCommand(argv, { cwd, timeoutMs: defaults.timeoutMs, signal })
  const r = readEvents(run.output)
  const sessionId = r.sessionId ?? session
  if (run.timedOut || run.aborted) {
    return {
      text: `${run.timedOut ? "timed out" : "cancelled"}${r.reply ? `; last reply so far:\n${r.reply}` : ""}`,
      isError: true,
      structured: { sessionId, reason: run.timedOut ? "timeout" : "aborted" },
    }
  }
  const failed = run.exitCode !== 0 || (r.reason !== undefined && r.reason !== "done")
  const problem = r.error ?? (lastLines(r.other) || undefined)
  const text = failed ? `Amira failed (${r.reason ?? `exit ${run.exitCode}`})${problem ? `: ${problem}` : ""}` : r.reply
  return {
    text: sessionId ? `${text}\n\n[amira session ${sessionId}]` : text,
    isError: failed,
    structured: {
      reply: r.reply,
      ...(sessionId ? { sessionId } : {}),
      reason: r.reason ?? "error",
      toolCalls: r.toolCalls,
    },
  }
}

interface Summary {
  reply: string
  sessionId?: string
  reason?: string
  error?: string
  toolCalls: number
  /** Lines that are not events: Amira's messages on stderr. */
  other: string[]
}

/** The facts a caller needs from `amira -p --json` output: last reply, session, outcome. */
export function readEvents(output: string): Summary {
  const out: Summary = { reply: "", toolCalls: 0, other: [] }
  for (const line of output.split(/\r?\n/)) {
    let e: { type?: string; data?: any } | undefined
    try {
      e = line.startsWith("{") ? JSON.parse(line) : undefined
    } catch {}
    if (!e) {
      if (line.trim()) out.other.push(line)
      continue
    }
    switch (e.type) {
      case "session.start": {
        const resume = e.data?.resume
        if (Array.isArray(resume) && typeof resume.at(-1) === "string") out.sessionId = resume.at(-1)
        break
      }
      case "message.end": {
        const content = e.data?.message?.content
        const text = Array.isArray(content)
          ? content
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join("")
          : ""
        if (text.trim()) out.reply = text
        break
      }
      case "tool.execute.start":
        out.toolCalls++
        break
      case "turn.end":
        out.reason = e.data?.reason
        if (typeof e.data?.error === "string") out.error = e.data.error
        break
    }
  }
  return out
}

function lastLines(lines: string[]): string {
  return lines.slice(-5).join("\n")
}
