import { expect, test } from "bun:test"
import { validateExtensionSetting } from "@amira/api"
import { settingFields } from "../src/prediction.ts"
import { fixture, flush } from "./fixture.ts"

test("declares enabled-by-default predictions and an optional model", () => {
  const f = fixture()
  expect(f.fields).toEqual(settingFields)
  expect(f.values()).toEqual({ enabled: true, model: "" })
})

for (const value of ["yes", 1, null, {}, []]) {
  test(`rejects a non-boolean enabled setting: ${JSON.stringify(value)}`, () => {
    expect(validateExtensionSetting(settingFields[0], value)).toBeDefined()
    expect(fixture({ settings: { enabled: value } }).values().enabled).toBe(true)
  })
}

for (const value of ["", "provider/model", "provider/namespace/model-v1"]) {
  test(`accepts a valid optional model reference: ${JSON.stringify(value)}`, () => {
    expect(validateExtensionSetting(settingFields[1], value)).toBeUndefined()
    expect(fixture({ settings: { model: value } }).values().model).toBe(value)
  })
}

for (const value of [
  "model",
  "/model",
  "provider/",
  " provider/model",
  "provider/model ",
  "provider /model",
  "provider/model\n",
  "provider/model name",
  `provider/${"m".repeat(200)}`,
  42,
  false,
  null,
  "p/\ud800",
]) {
  test(`rejects an invalid model reference: ${JSON.stringify(value)}`, () => {
    expect(validateExtensionSetting(settingFields[1], value)).toBeDefined()
    expect(fixture({ settings: { model: value } }).values().model).toBe("")
  })
}

test("saved model changes cancel the current suggestion and apply on the next turn", async () => {
  const f = fixture()
  f.end()
  await flush()
  expect(f.shown).toBe("run the tests")
  f.changeSettings({ model: "cheap/small" })
  expect(f.shown).toBeUndefined()
  f.start()
  f.end("done", "turn-2")
  await flush()
  expect(f.complete.mock.calls[1]![0].model).toBe("cheap/small")
})

test("re-enabling does not make another request for an already observed turn", async () => {
  const f = fixture({ settings: { enabled: false } })
  f.end()
  f.changeSettings({ enabled: true })
  f.end()
  await flush()
  expect(f.complete).not.toHaveBeenCalled()
  f.start()
  f.end("done", "turn-2")
  await flush()
  expect(f.complete).toHaveBeenCalledTimes(1)
})
