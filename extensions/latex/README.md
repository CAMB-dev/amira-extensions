# latex

LaTeX inline and display math, plus `math`, `latex` and `tex` fences in
[Amira](https://github.com/CAMB-dev/Amira)'s replies: Unicode text, with KaTeX pictures for
blocks when the `browser` and `images` extensions can draw them. Inline math always uses
Unicode text segments that wrap with the paragraph. Plain print mode (`amira -p`) uses text.

```sh
amira ext install latex
# Optional, for pictures:
amira ext install browser
amira ext install images
```

Requires Amira extension API 0.1.27 or later. An open fence or display math block stays
source while streaming. After it closes, the renderer replaces it. The inline transcript
waits up to 12 seconds for a picture; if that deadline expires, core commits the source
instead. Full-screen replies redraw when a picture arrives.

## Examples

Inline math uses `$…$` or `\(…\)`:

```markdown
The relation $x^2 + y^2 = z^2$ holds when \(\alpha = 0\).
```

Display math uses `$$…$$` or `\[…\]`, including multiline blocks:

```markdown
$$
x^2 + a_i \le \frac{\alpha}{\sqrt{2}}
$$

\[ E = mc^2 \]
```

Core recognizes the delimiters; code spans, escaped dollars and currency such as
`$5 and $10` stay literal. Unclosed math stays source.

Math fences still work:

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
iTerm2 protocols; this extension never writes terminal escape sequences itself. Each picture
carries the LaTeX source as `alt` and width-wrapped Unicode lines as `fallback`, used when
images cannot be drawn or the transcript is copied or printed.

## Text fallback

Inline math, print mode (`images: false`), `mode: "text"`, a source over 20,000 characters,
a missing browser or image provider, a terminal without graphics, `TERM=dumb`, and
browser/KaTeX failures all use the small hand-written converter:

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

- `mode`: `"auto"` (default) and `"image"` try pictures for blocks when supported and fall
  back to text; `"text"` never starts the browser. Inline math and print mode always use text.
- `maxWidth`: maximum picture width in CSS pixels, 16–4096 (default 900). The renderer also
  caps this at approximately ten pixels per available terminal column; core performs the
  final fit using the real cell size. Invalid settings use defaults. Reload after changes.

Pictures use the render context's theme: supplied foreground/background colours take
precedence, otherwise `theme.dark` selects light text on a dark card or dark text on a
light card. Only when the context has no theme does the legacy `COLORFGBG` hint apply
(background index 7 or 15 means light; otherwise dark). Fence rendering retains this
compatibility fallback, but loading the extension requires API 0.1.27 for math claims.

## Offline assets

Like `mermaid`, the browser service refuses network requests. KaTeX **0.16.22** is bundled
in `vendor/`: its minified JavaScript, CSS with WOFF2 fonts embedded as data URLs, and MIT
license. No CDN or runtime dependency installation is needed. Source:
<https://registry.npmjs.org/katex/-/katex-0.16.22.tgz> (`dist/katex.min.js`,
`dist/katex.min.css`, `dist/fonts/*.woff2`, `LICENSE`). CSS font `src` lists are reduced to
their WOFF2 entry, replacing the file URL with its base64 data URL. KaTeX runs with
`trust: false`, lenient strictness (warnings only) and bounded macro expansion; fonts load before the screenshot.

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
