// What this encodes, drawn by Amira's kit as the TUI draws replies' images: the two must fit.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeTerminal, ImageStore, LiveRenderer, MarkdownStream } from "@amira/tui-kit"
import { encode as encodePng } from "fast-png"
import { VirtualScreen } from "../node_modules/@amira/tui-kit/test/screen.ts"
import { ImageFiles } from "../src/provider.ts"

const dir = mkdtempSync(join(tmpdir(), "amira-images-kit-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const png = (w: number, h: number) =>
  encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255), channels: 4 })
writeFileSync(join(dir, "cat.png"), png(40, 60))
writeFileSync(join(dir, "a.png"), png(80, 120))

const CELL = { width: 10, height: 20 }

function store(protocol: "sixel" | "kitty" | "iterm2", files = new ImageFiles()) {
  return new ImageStore({
    support: { protocol, cell: CELL },
    open: (input, ctx) => files.open(input, ctx),
    cwd: dir,
    maxRows: () => 5,
  })
}

test("inline: the image is drawn in order, between the text around it", async () => {
  const term = new FakeTerminal(30, 12)
  const screen = new VirtualScreen(30, 12)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const m = new MarkdownStream({ hyperlinks: false, images: store("sixel") })
  const r = new LiveRenderer(term, m)
  r.start()
  m.append("before\n\n![cat](cat.png)\n\nafter\n\nmore")
  r.render()
  for (let i = 0; i < 100 && !screen.images.length; i++) {
    await Bun.sleep(20)
    r.render()
  }
  // 40×60 pixels: 4 columns, 3 rows.
  expect(screen.images).toEqual([{ protocol: "sixel", row: 2, col: 0, rows: 3, cols: 4 }])
  expect(screen.lines.slice(0, 8)).toEqual(["before", "", "▓▓▓▓", "▓▓▓▓", "▓▓▓▓", "", "after", ""])
  r.stop()
})

test("each protocol's sequence, sized to fit", async () => {
  const sixel = await store("sixel").load("cat.png", 2)
  expect({ cols: sixel!.cols, rows: sixel!.rows }).toEqual({ cols: 2, rows: 2 })
  expect(sixel!.seq).toStartWith('\x1bP0;1;0q"1;1;20;30#0;2;100;100;100')
  const iterm = await store("iterm2").load("cat.png", 2)
  expect(iterm!.seq).toStartWith(
    `\x1b]1337;File=inline=1;size=${png(40, 60).length};width=2;height=2;preserveAspectRatio=1:iVBOR`,
  )
  const kitty = await store("kitty").load("cat.png", 2)
  expect(kitty!.seq).toStartWith("\x1b_Ga=T,f=32,s=20,v=30,c=2,r=2,o=z,C=1,q=2,m=0;")
})

test("full screen: sized once opened, each size encoded once when wanted, sliced by the kit", async () => {
  let encoded = 0
  const files = new ImageFiles()
  const counting = new ImageStore({
    support: { protocol: "sixel", cell: CELL },
    open: async (input, ctx) => {
      const image = await files.open(input, ctx)
      return (
        image && {
          width: image.width,
          height: image.height,
          encode: (req) => {
            encoded++
            return image.encode(req)
          },
        }
      )
    },
    cwd: dir,
    maxRows: () => 20,
  })
  const source = counting.screen({ url: "a.png" })
  expect(source.state).toBe("loading")
  while (source.state === "loading") await Bun.sleep(5)
  expect(source.size).toEqual({ width: 80, height: 120 })
  // Synchronously sized: 6 rows at full size, 3 when the screen allows only 3.
  const big = source.image(30, 20)!
  expect([big.cols, big.rows]).toEqual([8, 6])
  const small = source.image(30, 3)!
  expect(small.rows).toBe(3)
  expect(encoded).toBe(0)
  await new Promise<void>((r) => big.whenReady(r))
  await new Promise<void>((r) => small.whenReady(r))
  expect(encoded).toBe(2)
  expect(big.draw(0, 6)).toStartWith('\x1bP0;1;0q"1;1;80;120')
  // A slice from its second row: the bands from pixel row 20.
  expect(big.draw(1, 3)).toStartWith('\x1bP0;1;0q"1;1;80;36')
  const missing = counting.screen({ url: "missing.png" })
  while (missing.state === "loading") await Bun.sleep(5)
  expect(missing.state).toBe("failed")
})
