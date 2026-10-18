import { describe, expect, test } from "bun:test"
import {
  observationResult,
  screenshotPoint,
  screenshotSize,
  selectTree,
  treeDensity,
  validateScreenshot,
} from "../src/perception.ts"
import { readSettings } from "../src/settings.ts"
import { fakeScreenshot } from "./perception-fixture.ts"

const tree = {
  text: 'e1 Window name="Target"\n  e2 Button name="OK" enabled=true offscreen=false\n  e3 unreadable\n  e4 Edit enabled=true offscreen=true',
  nodes: 4,
  chars: 100,
  ms: 5,
  cut: true,
}

describe("D113 screenshot-first perception (pure fakes)", () => {
  test("density ignores root, unreadable and offscreen nodes, and handles empty trees", () => {
    expect(treeDensity(tree.text)).toBe(1)
    expect(treeDensity("")).toBe(0)
    expect(treeDensity('e1 Pane name="custom"\ne2 Button enabled=false')).toBe(2)
    expect(treeDensity('e1 Button name="offscreen=true" enabled=true offscreen=false')).toBe(1)
    expect(treeDensity('e1 Button name="enabled=true offscreen=true" enabled=true offscreen=false')).toBe(1)
  })

  test("sparse tree omission is automatic and threshold is inclusive", () => {
    const sparse = selectTree({ ...tree, screenshot: fakeScreenshot() }, 2)
    expect(sparse).toMatchObject({ text: "", nodes: 4, treeOmitted: true, density: 1 })
    expect(selectTree({ ...tree, screenshot: fakeScreenshot() }, 1).text).toBe(tree.text)
    expect(selectTree({ ...tree, screenshot: fakeScreenshot() }, 0).treeOmitted).toBe(false)
    expect(selectTree(tree, 12).text).toBe(tree.text)
  })

  test("ToolResult includes a host ImageBlock, not base64 text or an artifact path", () => {
    const screenshot = validateScreenshot(fakeScreenshot(), 1280)
    const result = observationResult(selectTree({ ...tree, screenshot }, 12))
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: screenshot.data })
    const text = result.content[0]
    expect(text?.type).toBe("text")
    if (text?.type !== "text") throw new Error("Missing text")
    expect(text.text).not.toContain(screenshot.data)
    expect(text.text).not.toContain("e2 Button")
    expect(text.text).toContain(screenshot.id)
    expect(text.text).toContain("scaleX=")
    expect(text.text).toContain("Untrusted screen content")
  })

  test("downscaling bounds both axes, never upscales, reports actual axis ratios", () => {
    expect(screenshotSize(3840, 2160, 1280)).toEqual({
      width: 1280,
      height: 720,
      scaleX: 1 / 3,
      scaleY: 1 / 3,
    })
    expect(screenshotSize(300, 200, 1280)).toEqual({ width: 300, height: 200, scaleX: 1, scaleY: 1 })
    expect(screenshotSize(1001, 2003, 1280)).toEqual({
      width: 639,
      height: 1280,
      scaleX: 639 / 1001,
      scaleY: 1280 / 2003,
    })
    expect(screenshotSize(1, 10000, 1280).width).toBe(1)
    for (const bad of [0, -1, NaN, Infinity, 1.5]) expect(() => screenshotSize(bad, 100, 1280)).toThrow()
  })

  test("image-space mapping handles negative origins, independent rounding and mixed DPI", () => {
    const image = fakeScreenshot()
    expect(screenshotPoint(image, 640, 360)).toEqual({ x: -960, y: 640 })
    for (const dpi of [96, 120, 144, 192])
      expect(screenshotPoint({ ...image, dpi }, 640, 360)).toEqual({ x: -960, y: 640 })
    const portrait = fakeScreenshot("portrait", 1001, 2003)
    expect(screenshotPoint(portrait, 638, 1279)).toEqual({
      x: -1920 + Math.floor(638 / portrait.scaleX),
      y: 100 + Math.floor(1279 / portrait.scaleY),
    })
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [1280, 0],
      [0, 720],
      [NaN, 1],
      [0.5, 0],
    ])
      expect(() => screenshotPoint(image, x, y)).toThrow()
  })

  test("maximized visible-frame coordinates exclude negative invisible resize borders", () => {
    // Native GetWindowRect may be (-8,-8,1928,1048); helper uses DWM frame (0,0,1920,1040).
    const image = {
      ...fakeScreenshot("maximized", 1920, 1040),
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
    }
    expect(validateScreenshot(image, 1280)).toBe(image)
    expect(screenshotPoint(image, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(screenshotPoint(image, 1279, 692)).toEqual({ x: 1918, y: 1038 })
  })

  test("invalid screenshot shape, encoding, dimensions and scale fail closed", () => {
    const image = fakeScreenshot()
    for (const bad of [
      undefined,
      {},
      { ...image, data: "path/to/file" },
      { ...image, data: "AAAA" },
      { ...image, mimeType: "image/jpeg" },
      { ...image, width: 1279 },
      { ...image, scaleX: NaN },
      { ...image, scaleY: undefined },
      { ...image, scaleX: 1 },
      { ...image, dpi: 0 },
      { ...image, bounds: { ...image.bounds, x: Infinity } },
    ])
      expect(() => validateScreenshot(bad, 1280)).toThrow()
  })

  test("settings validate screenshot switch, bounded edge and density", () => {
    expect(
      readSettings({ screenshot: false, screenshotMaxEdge: 128, treeDensityThreshold: 0 }),
    ).toMatchObject({
      screenshot: false,
      screenshotMaxEdge: 128,
      treeDensityThreshold: 0,
    })
    for (const bad of [
      { screenshot: 0 },
      { screenshot: "false" },
      { screenshotMaxEdge: 127 },
      { screenshotMaxEdge: 4097 },
      { screenshotMaxEdge: 1.5 },
      { screenshotMaxEdge: NaN },
      { treeDensityThreshold: -1 },
      { treeDensityThreshold: 1001 },
      { treeDensityThreshold: "12" },
    ])
      expect(() => readSettings(bad)).toThrow()
  })
})
