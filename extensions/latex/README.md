# latex

LaTeX in `math`, `latex` and `tex` fences in [Amira](https://github.com/CAMB-dev/Amira)'s
replies: Unicode text everywhere the Markdown renderer runs, with KaTeX pictures when the
`browser` and `images` extensions can draw them.

```sh
amira ext install latex
# Optional, for pictures:
amira ext install browser
amira ext install images
```

Requires Amira extension API 0.1.3 or later. An open fence stays source while streaming.
After it closes, the renderer replaces it. The inline transcript waits up to 12 seconds
for a picture; if that deadline expires, core commits the source instead. Full-screen
replies redraw when a picture arrives.

## Example

Ask Amira to use a math fence:

````markdown
```math
x^2 + a_i \le \frac{\alpha}{\sqrt{2}}, \quad x \in \mathbb{R}
```
````

Text rendering:

```text
x² + aᵢ ≤ α/(√2),    x ∈ ℝ
```

Picture rendering uses typeset superscripts, subscripts, a stacked fraction and a radical
bar (the equation below is rendered by the README viewer, not by the terminal):

$$x^2 + a_i \le \frac{\alpha}{\sqrt{2}}, \quad x \in \mathbb{R}$$

Pictures are tightly cropped, scaled down without clipping to fit the width, and passed
as PNG bytes to Amira's image providers. The `images` extension handles Sixel, kitty and
iTerm2 protocols; this extension never writes terminal escape sequences itself.

## Text fallback

`mode: "text"`, a missing browser or image provider, a terminal without graphics,
`TERM=dumb`, and browser/KaTeX failures all use the small hand-written converter:

- Greek letters and common operators: `\alpha` → α, `\sum` → ∑, `\infty` → ∞,
  `\le` → ≤, `\rightarrow` → →, `\in` → ∈, `\mathbb{R}` → ℝ.
- Unicode scripts where available: `x^2` → x², `a_i` → aᵢ. Otherwise `^(…)` / `_(…)`.
- Fractions as `a/b`, with parentheses around compound operands; `\sqrt{x}` as √x.
- Nested groups, literal `\text{…}`, and unknown commands preserved rather than discarded.

This is a readable approximation, not a TeX engine. Long text wraps to the terminal width.
Invalid math stays readable as text; a browser failure is reported only once per extension
load. Picture results (including in-flight requests) are cached by source, width and theme,
with at most 64 entries. Syntax failures are cached; transient browser failures may retry.

## Settings

In your or the project's `settings.json`:

```json
{
  "extensions": {
    "latex": {
      "mode": "auto",
      "maxWidth": 900
    }
  }
}
```

- `mode`: `"auto"` (default) and `"image"` try pictures when supported and fall back to text;
  `"text"` never starts the browser.
- `maxWidth`: maximum picture width in CSS pixels, 16–4096 (default 900). The renderer also
  caps this at approximately ten pixels per available terminal column; core performs the
  final fit using the real cell size. Invalid settings use defaults. Reload after changes.

Pictures use light text on a dark card by default. When the terminal sets `COLORFGBG` with
background index 7 or 15, they use dark text on a light card. This is a best-effort hint,
not access to Amira's theme; no theme information is exposed in the renderer context.

## Current core limits

Checked against `packages/api/src/render.ts`, `packages/tui/src/markdown-nodes.ts`,
`packages/tui/src/blocks/reply.ts`, `packages/tui-kit/src/markdown/` and
`packages/cli/src/print.ts` in the local Amira checkout. No core files are changed.

- **Only fences are claimable.** `MarkdownNode` contains only code and standalone images;
  `MarkdownRenderMatch` only has `codeLang` and `image`. The parser has no math nodes:
  `$$…$$` and `\[…\]` go through ordinary paragraph/escape handling. Supporting these
  requires math-aware block tokenization (including streaming closure), a display-math
  node/matcher in the API and registry, and dispatch in both transcript render paths.
- **Inline math is unchanged by this extension.** `$…$` and `\(…\)` cannot be claimed.
  Core needs an inline-math tokenizer and a text-only inline renderer contract wired into
  paragraph layout, preserving surrounding emphasis, links and wrapping. Dollar recognition
  must exclude escaped dollars and code spans, require no space after the opening or before
  the closing `$`, and reject a digit immediately after the closing `$`. Currency such as
  `$5 and $10` is not interpreted as math here.
- **`--print` bypasses Markdown renderers.** Plain renderer contexts (`images: false`) use
  Unicode, but actual CLI print/JSON output remains original source. Core would need to
  route completed blocks through the renderer registry with `images: false`, retaining
  streaming source while incomplete. The extension does not mutate stored/model replies.
- **Terminal image alt text cannot be supplied.** `MarkdownRenderResult`/`ImageInput` have
  no alt or text-fallback field. The HTML card's accessible label is the exact LaTeX source,
  but screenshot bytes cannot carry that label to the transcript. Core needs optional alt
  text and fallback lines on image results, propagated through inline pending images and
  full-screen image marks. Currently core supplies its own code/language fallback if image
  decoding/encoding fails, or an async render exceeds the inline deadline.
- **Exact theme tracking needs core support.** Expose light/dark appearance (ideally actual
  foreground/background colours) in `MarkdownRenderContext`, include it in renderer cache
  keys, and invalidate/re-render on theme changes. Until then `COLORFGBG` is only a hint.

## Offline assets

Like `mermaid`, the browser service refuses network requests. KaTeX **0.16.22** is bundled
in `vendor/`: its minified JavaScript, CSS with WOFF2 fonts embedded as data URLs, and MIT
license. No CDN or runtime dependency installation is needed. Source:
<https://registry.npmjs.org/katex/-/katex-0.16.22.tgz> (`dist/katex.min.js`,
`dist/katex.min.css`, `dist/fonts/*.woff2`, `LICENSE`). CSS font `src` lists are reduced to
their WOFF2 entry, replacing the file URL with its base64 data URL. KaTeX runs with
`trust: false`, strict errors and bounded macro expansion; fonts load before the screenshot.

## Development

```sh
bun install
bun scripts/link-amira.ts D:/dev/Amira
bun test
D:/dev/Amira/node_modules/.bin/tsc --noEmit -p tsconfig.json
D:/dev/Amira/node_modules/.bin/biome check --config-path=D:/dev/Amira src test scripts package.json tsconfig.json
```

Tests cover the converter, claims, settings, text-only contexts, image caching, theme,
failures, page isolation and the bundled KaTeX. No real browser or image terminal is
required for the tests. Vendored minified assets are not reformatted or linted.
