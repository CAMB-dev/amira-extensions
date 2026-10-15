import { checkAskAnswers } from "D:/dev/Amira/packages/core/src/ask-answers.ts"
import { expect, test } from "bun:test"
import type { AskQuestion } from "@amira/api"
import { validateAskAnswers } from "../src/answers.ts"

const question: AskQuestion = {
  question: "Which deployment?",
  header: "Deployment",
  options: [
    { label: "One service", description: "Fewer operations, coupled scaling." },
    { label: "Many services", description: "More operations, independent scaling." },
  ],
}
const cases: { name: string; value: unknown; multi?: boolean; valid: boolean }[] = [
  { name: "one selection", value: [{ selected: ["One service"] }], valid: true },
  { name: "Other-only", value: [{ selected: [], other: "A hosted platform" }], valid: true },
  { name: "empty multi", value: [{ selected: [] }], multi: true, valid: true },
  {
    name: "selected multi",
    value: [{ selected: ["One service", "Many services"] }],
    multi: true,
    valid: true,
  },
  {
    name: "multi with Other",
    value: [{ selected: ["One service"], other: "Another shape" }],
    multi: true,
    valid: true,
  },
  { name: "zero single", value: [{ selected: [] }], valid: false },
  { name: "multiple single", value: [{ selected: ["One service", "Many services"] }], valid: false },
  {
    name: "selected and Other single",
    value: [{ selected: ["One service"], other: "An alternative" }],
    valid: false,
  },
  {
    name: "duplicate selection",
    value: [{ selected: ["One service", "One service"] }],
    multi: true,
    valid: false,
  },
  { name: "unknown selection", value: [{ selected: ["Unknown"] }], valid: false },
  { name: "blank Other", value: [{ selected: [], other: "  " }], valid: false },
  { name: "non-text Other", value: [{ selected: [], other: 1 }], valid: false },
  { name: "missing selected", value: [{ other: "A platform" }], valid: false },
  { name: "wrong answer count", value: [], valid: false },
  { name: "not an object", value: [null], valid: false },
  { name: "not an array", value: null, valid: false },
]

for (const entry of cases) {
  test(`shared answer validation agrees with actual host semantics: ${entry.name}`, () => {
    const questions = [{ ...question, ...(entry.multi ? { multiSelect: true } : {}) }]
    expect(checkAskAnswers(questions, entry.value) === undefined).toBe(entry.valid)
    if (entry.valid) expect(entry.value).toEqual(validateAskAnswers(questions, entry.value))
    else expect(() => validateAskAnswers(questions, entry.value)).toThrow()
  })
}

test("the shared validator captures a clone rather than mutable UI evidence", () => {
  const answers = [{ selected: ["One service"] }]
  const captured = validateAskAnswers([question], answers)
  answers[0]!.selected[0] = "Many services"
  expect(captured).toEqual([{ selected: ["One service"] }])
})
