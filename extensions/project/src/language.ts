import type { Message } from "@amira/api"

/** The sentinel follows the human's conversation, never the terminal's locale. */
export function resolveLanguage(
  project: string | undefined,
  extension: string,
  conversation: string,
): string {
  const configured = project ?? extension
  return configured === "conversation" ? conversation : configured
}

/** Only human-looking user turns are considered; notices and model replies are not authority. */
export function conversationLanguage(messages: readonly Message[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || message.display?.origin) continue
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
    if (!text.trim() || text.trim().startsWith("/")) continue
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja"
    if (/\p{Script=Han}/u.test(text)) return "zh-CN"
    // English is a conservative convenience heuristic, not a general language detector.
    if (/\b(the|a|an|please|this|project|design|create|want|need|use|let|hello)\b/i.test(text)) return "en"
  }
  return undefined
}

export function validLanguage(value: string): boolean {
  if (value === "conversation") return true
  try {
    return Intl.getCanonicalLocales(value).length === 1
  } catch {
    return false
  }
}

export function isChinese(language: string): boolean {
  return language.toLowerCase().startsWith("zh")
}

/** Generated scaffolding is supported in English, Chinese and Japanese, including regional tags. */
export function localize(language: string, en: string, zh: string, ja: string): string {
  const primary = language.toLowerCase().split("-")[0]
  return primary === "zh" ? zh : primary === "ja" ? ja : en
}

/** Shared by commands and design sessions so an unsupported effective tag is announced once. */
export class LanguagePolicy {
  private readonly announced = new Set<string>()

  resolve(tag: string, notify: (message: string) => void): string {
    if (!validLanguage(tag) || tag === "conversation")
      throw new Error("Choose a valid document language tag, such as en, zh or ja.")
    const canonical = Intl.getCanonicalLocales(tag)[0]!
    const primary = canonical.toLowerCase().split("-")[0]
    if (primary === "en") return "en"
    if (primary === "zh") return "zh-CN"
    if (primary === "ja") return "ja"
    if (!this.announced.has(canonical)) {
      this.announced.add(canonical)
      notify(
        `Project language ${JSON.stringify(canonical)} is not supported; using English for new content. Supported languages: en, zh, ja.`,
      )
    }
    return "en"
  }
}
