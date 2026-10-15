import type { AskAnswer, AskQuestion } from "@amira/api"

/** Match the host's owner-answer rules; Other is a choice, not an explanation. */
export function validateAskAnswers(questions: AskQuestion[], answers: unknown): AskAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw new Error("The human response must answer every question")
  for (const [index, question] of questions.entries()) {
    const answer: unknown = answers[index]
    if (!answer || typeof answer !== "object" || Array.isArray(answer))
      throw new Error("The human response must contain answer objects")
    const value = answer as Record<string, unknown>
    if (
      !Array.isArray(value.selected) ||
      value.selected.some(
        (label) => typeof label !== "string" || !question.options.some((option) => option.label === label),
      ) ||
      new Set(value.selected).size !== value.selected.length
    )
      throw new Error("The human response contains an invalid selection")
    if (value.other !== undefined && (typeof value.other !== "string" || !value.other.trim()))
      throw new Error("A free-text answer must not be empty")
    const count = value.selected.length + (value.other !== undefined ? 1 : 0)
    if (!question.multiSelect && count !== 1)
      throw new Error("The human response must choose one option or give Other text")
  }
  // Capture before the first persistence await. Later UI mutation must not alter evidence.
  return structuredClone(answers) as AskAnswer[]
}
