import { stripVTControlCharacters } from "node:util"
import type { ExtensionSettingsField, Message, UserMessage } from "@amira/api"

export const settingFields = [
  {
    key: "enabled",
    type: "toggle",
    default: true,
    label: "Suggest your next message",
    description: "Make one paid prediction after each successful turn when the prompt is empty.",
  },
  {
    key: "model",
    type: "text",
    default: "",
    label: "Prediction model",
    description: "Leave empty to use the session model and its conversation cache prefix.",
    placeholder: "provider/model",
    pattern: "(?:[^\\s/]+/[^\\s]+)?",
    maxLength: 200,
  },
] as const satisfies readonly ExtensionSettingsField[]

export const INSTRUCTION =
  "Predict exactly one short line this user is likely to type next, in their language and writing style " +
  "(for example: continue / run the tests / commit it). Write the user's message, not an assistant reply " +
  "or instructions for a model. No quotes, labels, explanations or tool calls. Return nothing if unsure."

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

export function textOf(message: Message): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

/** At most six recent user/assistant excerpts, 1,000 characters each and 6,000 in total. */
export function recentContext(messages: readonly Message[]): string {
  const excerpts: string[] = []
  let remaining = 6000
  for (let i = messages.length - 1; i >= 0 && excerpts.length < 6; i--) {
    const message = messages[i]!
    if (message.role === "toolResult") continue
    const text = textOf(message).trim()
    if (!text) continue
    const prefix = `${message.role}: `
    const excerpt = prefix + text.slice(-Math.min(1000, remaining - prefix.length))
    excerpts.unshift(excerpt)
    remaining -= excerpt.length + 2
    if (remaining <= 20) break
  }
  return excerpts.join("\n\n")
}

function normalized(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, " ")
    .trim()
}

const MODEL_OUTPUT = [
  /^(?:```|(?:assistant|user|system|prediction|suggestion)\s*:)/iu,
  /^(?:you are\b|as an? (?:ai|assistant)\b)/iu,
  /^ignore (?:all |the |previous )*(?:instructions|prompts)\b/iu,
  /^(?:return|output|respond with|write|generate) (?:exactly |only )?(?:one |a |the )?(?:short |single )?(?:line|prediction|user.?s (?:next )?message)\b/iu,
  /^(?:please )?predict\b.*\b(?:user|message|line|next)\b/iu,
  /^(?:here is|here's) (?:the |a )?(?:prediction|suggestion)\b/iu,
  /^the user (?:will|might|would|is likely to)\b/iu,
]

export function cleanPrediction(text: string, assistantText: string): string | undefined {
  const line = stripVTControlCharacters(text)
    .trim()
    .split(/[\r\n\u2028\u2029]/u)[0]!
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .replace(/^["'“‘](.*)["'”’]$/u, "$1")
    .trim()
  if (!line || MODEL_OUTPUT.some((pattern) => pattern.test(line))) return
  const candidate = normalized(line)
  const assistant = normalized(assistantText)
  if (
    !candidate ||
    candidate === assistant ||
    assistantText.split(/\r?\n/u).some((part) => normalized(part) === candidate) ||
    (candidate.length >= 24 && assistant.includes(candidate))
  ) {
    return
  }
  return Array.from(line).slice(0, 120).join("").trim()
}
