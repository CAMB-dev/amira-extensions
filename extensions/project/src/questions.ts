import type { AskQuestion } from "@amira/api"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim()
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((name) => allowed.includes(name))

/** Shared payload rules for dialogs and evidence. Header text is never trimmed or required. */
export function validateAskQuestions(value: unknown, guided = false): AskQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new Error("Ask one to four questions")
  for (const item of value) {
    if (
      !object(item) ||
      !keys(item, ["question", "header", "options", "multiSelect"]) ||
      !nonempty(item.question)
    )
      throw new Error("Invalid AskQuestion")
    if (item.header !== undefined && (typeof item.header !== "string" || Array.from(item.header).length > 12))
      throw new Error("Question headers must have at most 12 characters")
    if (item.multiSelect !== undefined && typeof item.multiSelect !== "boolean")
      throw new Error("multiSelect must be a boolean")
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 4)
      throw new Error("Each question needs two to four options")
    const labels = new Set<string>()
    for (const option of item.options) {
      if (
        !object(option) ||
        !keys(option, ["label", "description"]) ||
        !nonempty(option.label) ||
        (option.description !== undefined && typeof option.description !== "string")
      )
        throw new Error("Invalid question option")
      if (guided && !nonempty(option.description))
        throw new Error("Every option's trade-off description must not be empty")
      const label = guided ? option.label.trim().toLowerCase() : option.label
      if (labels.has(label)) throw new Error("Option labels must be unique")
      if (guided && /^other\b/.test(label)) throw new Error("Other is built in; do not add an Other option")
      labels.add(label)
    }
  }
  return structuredClone(value) as AskQuestion[]
}
