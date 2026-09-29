import type { CommandContext, JSONSchema } from "@amira/api"

export interface AskOptions {
  /** Names the spawn group, shown by frontends. */
  name: string
  /** A few words, shown on the sub-agent's line. */
  title: string
  role?: string
  prompt: string
  systemPrompt: string
  /** An object schema: the value comes back as that object. */
  schema: JSONSchema
  /** "provider/model"; default the session's model. */
  model?: string
  /** Tools it may use; default none (a one-shot answer). */
  tools?: string[]
}

export type AskResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Asks the model once for a structured answer, through a sub-agent of the session that has
 * to hand back a value fitting `schema`. The only way to reach a model through the API, and
 * it keeps the call visible where the frontend shows sub-agents. Esc on the command (its
 * signal) stops it.
 */
export async function askModel<T>(ctx: CommandContext, o: AskOptions): Promise<AskResult<T>> {
  const create = ctx.session.createGroup
  if (!create)
    return { ok: false, error: "this frontend cannot start sub-agents, which the model call needs" }
  let group: ReturnType<typeof create>
  try {
    group = create({ name: o.name, maxAgents: 1 })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const child = group.spawn({
      role: o.role ?? "share",
      title: o.title,
      prompt: o.prompt,
      systemPrompt: o.systemPrompt,
      schema: o.schema,
      tools: o.tools ?? [],
      ...(o.model ? { model: o.model } : {}),
    })
    const stop = () => child.abort("stopped by the user")
    if (ctx.signal.aborted) stop()
    ctx.signal.addEventListener("abort", stop, { once: true })
    try {
      const r = await child.result()
      if (r.status === "done" && r.value !== undefined) return { ok: true, value: r.value as T }
      if (r.status === "aborted") return { ok: false, error: r.error ?? "stopped" }
      return { ok: false, error: r.error ?? "the model gave no answer" }
    } finally {
      ctx.signal.removeEventListener("abort", stop)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    group.end("done")
  }
}
