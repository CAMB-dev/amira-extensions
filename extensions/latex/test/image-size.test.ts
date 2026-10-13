import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { MathImages, mathPage } from "../src/index.ts"

/** Execute the real crop script with deterministic layout metrics, without launching a browser. */
async function crop(size: number, width = 900) {
  const html = mathPage("x^2", width, "dark", size)
  const cssSize = Number(/#formula\{[^}]*font-size:(\d+)px/.exec(html)![1])
  const card = { style: { width: "", height: "" }, setAttribute: () => {} }
  const formula = {
    style: { transform: "", transformOrigin: "" },
    appendChild: () => {},
    // Simulate a short formula's browser-measured box at the actual CSS font size.
    getBoundingClientRect: () => ({ width: cssSize * 4, height: cssSize * 1.25 }),
  }
  const sandbox = {
    window: { amiraRenderDone: undefined as Promise<void> | undefined },
    document: {
      body: { style: {} },
      fonts: { ready: Promise.resolve() },
      getElementById: (id: string) => (id === "math" ? card : formula),
      createElement: () => ({}),
    },
    katex: { render: () => {} },
  }
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!
  runInNewContext(script, sandbox)
  await sandbox.window.amiraRenderDone
  return { width: Number.parseInt(card.style.width, 10), height: Number.parseInt(card.style.height, 10) }
}

test("font size changes tightly cropped image dimensions instead of just screenshot resolution", async () => {
  expect(await crop(8)).toEqual({ width: 40, height: 18 })
  expect(await crop(16)).toEqual({ width: 72, height: 28 })
  expect(await crop(32)).toEqual({ width: 136, height: 48 })
  expect(await crop(64)).toEqual({ width: 264, height: 88 })
  expect(mathPage("x", 900, "dark", 32)).toContain(".katex{font-size:1em}")
  expect(await crop(64, 100)).toEqual({ width: 100, height: 37 })
})

test("image cache distinguishes size and inline/display style and clear drops in-flight entries", async () => {
  const images = new MathImages()
  let calls = 0
  const render = async () => new Uint8Array([++calls])
  expect(await images.render("x", 900, "dark", render, 16)).toEqual(new Uint8Array([1]))
  expect(await images.render("x", 900, "dark", render, 32)).toEqual(new Uint8Array([2]))
  expect(await images.render("x", 900, "dark", render, 16)).toEqual(new Uint8Array([1]))
  expect(await images.render([{ source: "x", display: true }], 900, "dark", render, 16)).toEqual(
    new Uint8Array([1]),
  )
  expect(await images.render([{ source: "x", display: false }], 900, "dark", render, 16)).toEqual(
    new Uint8Array([3]),
  )
  const pending = images.render("pending", 900, "dark", render, 16)
  images.clear()
  const replacement = images.render("pending", 900, "dark", render, 16)
  expect(replacement).not.toBe(pending)
  await pending
  await replacement
  expect(calls).toBe(5)
  expect(await images.render("pending", 900, "dark", render, 16)).toEqual(new Uint8Array([5]))
})
