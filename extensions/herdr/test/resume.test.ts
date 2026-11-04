import { expect, test } from "bun:test"
import { cleanMessage, herdrState, MAX_RESUME_ARGS, resumeArgv, validResumeArgv } from "../src/index.ts"

const model = { provider: "deepseek", model: "deepseek-chat" }

test("resume commands herdr accepts", () => {
  expect(validResumeArgv(["amira", "--resume", "s_01"])).toBe(true)
  expect(validResumeArgv(["amira.cmd", "-r", "s_01"])).toBe(true)
  expect(validResumeArgv(Array.from({ length: MAX_RESUME_ARGS }, () => "amira"))).toBe(true)
})

test("resume commands herdr refuses", () => {
  expect(validResumeArgv([])).toBe(false)
  expect(validResumeArgv(["/usr/local/bin/amira", "--resume", "s"])).toBe(false)
  expect(validResumeArgv(["C:amiraamira.exe", "--resume", "s"])).toBe(false)
  expect(validResumeArgv(["./amira"])).toBe(false)
  expect(validResumeArgv(["amira", "--resume", "it's"])).toBe(false)
  expect(validResumeArgv(["amira", "--resume", "a\nb"])).toBe(false)
  expect(validResumeArgv(["amira", "\u001b[0m"])).toBe(false)
  expect(validResumeArgv(Array.from({ length: MAX_RESUME_ARGS + 1 }, () => "amira"))).toBe(false)
  expect(validResumeArgv(["amira", "x".repeat(8 * 1024)])).toBe(false)
})

test("the resume command keeps the model", () => {
  expect(resumeArgv(["amira", "--resume", "s"], model)).toEqual([
    "amira",
    "--resume",
    "s",
    "--model",
    "deepseek/deepseek-chat",
  ])
  expect(resumeArgv(["amira", "--resume", "s"], { provider: "", model: "" })).toEqual([
    "amira",
    "--resume",
    "s",
  ])
  expect(resumeArgv(["amira", "--resume", "s", "-m", "a/b"], model)).toEqual([
    "amira",
    "--resume",
    "s",
    "-m",
    "a/b",
  ])
  // A model reference herdr would refuse is left out, the rest stays.
  expect(resumeArgv(["amira", "--resume", "s"], { provider: "p", model: "it's" })).toEqual([
    "amira",
    "--resume",
    "s",
  ])
  expect(resumeArgv(["/bin/amira", "--resume", "s"], model)).toBeUndefined()
  expect(resumeArgv(undefined, model)).toBeUndefined()
})

test("messages", () => {
  expect(cleanMessage(undefined)).toBeUndefined()
  expect(cleanMessage(" \n ")).toBeUndefined()
  expect(cleanMessage("approval\tfor\r\nbash")).toBe("approval for bash")
  expect(cleanMessage("--force?")).toBe("force?")
  expect([...cleanMessage("é".repeat(100))!].length).toBe(80)
})

test("states", () => {
  expect(herdrState("working")).toBe("working")
  expect(herdrState("blocked")).toBe("blocked")
  expect(herdrState("idle")).toBe("idle")
  expect(herdrState("error")).toBe("idle")
})
