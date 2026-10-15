import { expect, test } from "bun:test"
import { validateAskQuestions } from "../src/questions.ts"

const question = {
  question: "Which store?",
  options: [
    { label: "Local", description: "Offline; manual backups." },
    { label: "Remote", description: "Sync; needs hosting." },
  ],
}
for (const header of [undefined, "", "   ", "Storage", "abcdefghijkl", "🧭".repeat(12)]) {
  test(`dialog and evidence validation both preserve header ${JSON.stringify(header)}`, () => {
    const offered = [{ ...question, ...(header !== undefined ? { header } : {}) }]
    expect(validateAskQuestions(offered, true)).toEqual(offered)
    expect(validateAskQuestions(offered)).toEqual(offered)
  })
}
for (const header of [null, 0, "abcdefghijklm", "             ", "🧭".repeat(13)]) {
  test(`dialog and evidence validation both reject invalid header ${JSON.stringify(header)}`, () => {
    const offered = [{ ...question, header }]
    expect(() => validateAskQuestions(offered, true)).toThrow("headers")
    expect(() => validateAskQuestions(offered)).toThrow("headers")
  })
}
test("question validation captures exact independent payloads without normalizing headers", () => {
  const offered = [{ ...question, header: "   " }]
  const captured = validateAskQuestions(offered, true)
  offered[0]!.header = "Changed"
  expect(captured[0]!.header).toBe("   ")
  expect(validateAskQuestions(captured)).toEqual(captured)
})
