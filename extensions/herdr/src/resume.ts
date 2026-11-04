import type { ModelRef } from "@amira/api"

/** herdr's limits for a resume command (add-herdr-support: "Report the resume command"). */
export const MAX_RESUME_ARGS = 64
export const MAX_RESUME_BYTES = 8 * 1024

/** A plain command name: no directory part, so herdr finds it on the user's PATH. */
const PLAIN_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Whether herdr accepts `argv` as a resume command: the first word a plain command name, no
 * argument with an apostrophe or a control character, at most 64 arguments and 8 KiB in all.
 */
export function validResumeArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv.length > MAX_RESUME_ARGS) return false
  if (!PLAIN_COMMAND.test(argv[0]!)) return false
  let bytes = 0
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("'") || CONTROL.test(arg)) return false
    bytes += Buffer.byteLength(arg, "utf8")
  }
  return bytes <= MAX_RESUME_BYTES
}

/** "provider/model", or undefined without a model (Amira's placeholder has no provider). */
export function modelArg(model: ModelRef | undefined): string | undefined {
  if (!model?.provider || !model.model) return undefined
  return `${model.provider}/${model.model}`
}

/**
 * The command that reopens the session: Amira's own (`amira --resume <id>`), with `--model`
 * for the session's current model, since `--resume` alone takes the model from settings.json
 * when that names one. Undefined when herdr would refuse it; without the model when only the
 * model makes it invalid.
 */
export function resumeArgv(resume: readonly string[] | undefined, model?: ModelRef): string[] | undefined {
  if (!resume || !validResumeArgv(resume)) return undefined
  // Someone else's flag already picks the model: keep the command as Amira wrote it.
  if (resume.some((a) => a === "--model" || a === "-m" || a.startsWith("--model="))) return [...resume]
  const ref = modelArg(model)
  const withModel = ref ? [...resume, "--model", ref] : undefined
  return withModel && validResumeArgv(withModel) ? withModel : [...resume]
}
