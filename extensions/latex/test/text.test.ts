import { describe, expect, test } from "bun:test"
import { latexToText } from "../src/text.ts"

describe("latexToText", () => {
  test("preserves ordinary source and whitespace", () => {
    for (const source of ["", "x + y = 2", "  x\n\t y  ", "中文 + 😀", "$5 and $10"]) {
      expect(latexToText(source)).toBe(source)
    }
  })

  test("does not treat math source as Markdown or strip math delimiters", () => {
    expect(latexToText("$5 and $10")).toBe("$5 and $10")
    expect(latexToText("$x$ and $$y$$")).toBe("$x$ and $$y$$")
    expect(latexToText(String.raw`\(x\) and \[y\]`)).toBe(String.raw`\(x\) and \[y\]`)
    expect(latexToText("**x** and `y`")).toBe("**x** and `y`")
  })

  test("converts lower-case Greek letters and variants", () => {
    expect(latexToText(String.raw`\alpha\beta\gamma\delta\epsilon\varepsilon\zeta\eta\theta\vartheta`)).toBe(
      "αβγδϵεζηθϑ",
    )
    expect(latexToText(String.raw`\iota\kappa\lambda\mu\nu\xi\omicron\pi\varpi\rho\varrho`)).toBe(
      "ικλμνξοπϖρϱ",
    )
    expect(latexToText(String.raw`\sigma\varsigma\tau\upsilon\phi\varphi\chi\psi\omega`)).toBe("σςτυϕφχψω")
  })

  test("converts upper-case Greek letters", () => {
    expect(latexToText(String.raw`\Gamma\Delta\Theta\Lambda\Xi\Pi\Sigma\Upsilon\Phi\Psi\Omega`)).toBe(
      "ΓΔΘΛΞΠΣΥΦΨΩ",
    )
  })

  test("converts arithmetic, relations, sets, logic, and arrows", () => {
    expect(latexToText(String.raw`a \times b \cdot c \div d \pm e \mp f`)).toBe("a × b · c ÷ d ± e ∓ f")
    expect(latexToText(String.raw`\le\leq\ge\geq\ne\neq\approx\equiv\propto`)).toBe("≤≤≥≥≠≠≈≡∝")
    expect(latexToText(String.raw`\in\notin\subset\subseteq\supset\supseteq\cup\cap\emptyset`)).toBe(
      "∈∉⊂⊆⊃⊇∪∩∅",
    )
    expect(latexToText(String.raw`\forall\exists\neg\land\lor\to\mapsto\implies\iff`)).toBe("∀∃¬∧∨→↦⇒⇔")
    expect(latexToText(String.raw`\leftarrow\leftrightarrow\Leftarrow\uparrow\downarrow`)).toBe("←↔⇐↑↓")
  })

  test("converts calculus, functions, and punctuation", () => {
    expect(latexToText(String.raw`\sum\prod\int\iint\oint\partial\nabla\infty`)).toBe("∑∏∫∬∮∂∇∞")
    expect(latexToText(String.raw`\sin(x) + \cos(x) + \log(x) + \ln(x) + \exp(x)`)).toBe(
      "sin(x) + cos(x) + log(x) + ln(x) + exp(x)",
    )
    expect(latexToText(String.raw`\ldots\cdots\vdots\ddots\langle x\rangle`)).toBe("…⋯⋮⋱⟨ x⟩")
  })

  test("converts escapes and explicit spacing", () => {
    expect(latexToText(String.raw`\{x\} \$5 \% \& \_ \# \backslash`)).toBe("{x} $5 % & _ # \\")
    expect(latexToText(String.raw`a\,b\;c\:d\!e\quad f\qquad g`)).toBe("a b c de   f     g")
    expect(latexToText(String.raw`a\\b`)).toBe("a\nb")
  })

  test("removes grouping braces recursively", () => {
    expect(latexToText(String.raw`{{{\alpha}} + {x}}`)).toBe("α + x")
    expect(latexToText("{}a{{}}b")).toBe("ab")
    expect(latexToText(String.raw`{\{x\}}`)).toBe("{x}")
  })

  test("renders scalable delimiters, including invisible ones", () => {
    expect(latexToText(String.raw`\left(\frac{a}{b}\right)`)).toBe("(a/b)")
    expect(latexToText(String.raw`\left\{x\right\}`)).toBe("{x}")
    expect(latexToText(String.raw`\left.x\right|`)).toBe("x|")
  })

  test("renders blackboard letters, including non-BMP characters", () => {
    expect(latexToText(String.raw`\mathbb{R} \mathbb{N} \mathbb{Z} \mathbb{Q} \mathbb{C} \mathbb{H}`)).toBe(
      "ℝ ℕ ℤ ℚ ℂ ℍ",
    )
    expect(latexToText(String.raw`\mathbb{ABP}^2`)).toBe("𝔸𝔹ℙ²")
    expect(latexToText(String.raw`\mathbb{unknown} + x`)).toBe(String.raw`\mathbb{unknown} + x`)
    expect(latexToText(String.raw`\mathrm{x} + \mathbf{y} + \mathit{\alpha}`)).toBe("x + y + α")
  })

  describe("scripts", () => {
    const cases = [
      ["x^2 + y_1", "x² + y₁"],
      ["x^{0123456789}", "x⁰¹²³⁴⁵⁶⁷⁸⁹"],
      ["x_{0123456789}", "x₀₁₂₃₄₅₆₇₈₉"],
      ["x^{n+1} + y_{i-2}", "xⁿ⁺¹ + yᵢ₋₂"],
      ["x^{(n=2)}", "x⁽ⁿ⁼²⁾"],
      ["x^{abcdefghijklmnopqrstuvwxyz}", "x^(abcdefghijklmnopqrstuvwxyz)"],
      ["x^{abc} + y_{max}", "xᵃᵇᶜ + yₘₐₓ"],
      [String.raw`x^{\alpha+1}`, "x^(α+1)"],
      [String.raw`x_{\beta}`, "xᵦ"],
      ["x_{j+q}", "x_(j+q)"],
      ["x^{a b}", "x^(a b)"],
      ["x^{y_1}", "x^(y₁)"],
      ["x_1^2", "x₁²"],
      ["x^23", "x²3"],
      ["x_12", "x₁2"],
      ["x^ {2} + y_ {3}", "x² + y₃"],
      ["x^{} + y_{}", "x + y"],
      ["x^😀z", "x^(😀)z"],
    ]
    for (const [source, expected] of cases) {
      test(source!, () => expect(latexToText(source!)).toBe(expected!))
    }
  })

  describe("fractions", () => {
    const cases = [
      [String.raw`\frac{1}{2}`, "1/2"],
      [String.raw`\dfrac{12}{34} + \tfrac{x}{y}`, "12/34 + x/y"],
      [String.raw`\frac{a+b}{c+d}`, "(a+b)/(c+d)"],
      [String.raw`\frac{ab}{xy}`, "(ab)/(xy)"],
      [String.raw`\frac{\frac{a}{b}}{c}`, "(a/b)/c"],
      [String.raw`\frac{a}{\frac{b}{c}}`, "a/(b/c)"],
      [String.raw`\frac{\frac{a}{b}}{\frac{c}{d}}`, "(a/b)/(c/d)"],
      [String.raw`\frac{a}{b+c}z`, "a/(b+c)z"],
      [String.raw`\frac{\alpha}{\mathbb{A}}`, "α/𝔸"],
      [String.raw`\frac {x} {y} + z`, "x/y + z"],
      [String.raw`\frac{{a+b}}{{c+d}}`, "(a+b)/(c+d)"],
      [String.raw`x^{\frac{1}{2}}`, "x^(1/2)"],
    ]
    for (const [source, expected] of cases) {
      test(source!, () => expect(latexToText(source!)).toBe(expected!))
    }
  })

  test("renders roots and nested expressions", () => {
    expect(latexToText(String.raw`\sqrt{x} + \sqrt{x^2 + y^2}`)).toBe("√x + √(x² + y²)")
    expect(latexToText(String.raw`\sqrt{\frac{a+b}{c}}`)).toBe("√((a+b)/c)")
    expect(latexToText(String.raw`\sqrt{\sqrt{x}}z`)).toBe("√(√x)z")
    expect(latexToText(String.raw`\sqrt[3]{x} + \sqrt[n+1]{y}`)).toBe("³√x + ⁿ⁺¹√y")
    expect(latexToText(String.raw`\sqrt[\alpha]{x}`)).toBe("^(α)√x")
  })

  test("treats text arguments as literal text", () => {
    expect(latexToText(String.raw`\text{hello world} + x`)).toBe("hello world + x")
    expect(latexToText(String.raw`\text{a_b^2 + \alpha}`)).toBe(String.raw`a_b^2 + \alpha`)
    expect(latexToText(String.raw`\text{outer {inner} tail}`)).toBe("outer {inner} tail")
    expect(latexToText(String.raw`\text{\{cost\}: \$5 and \$10, 50\%}`)).toBe("{cost}: $5 and $10, 50%")
    expect(latexToText(String.raw`\text{ leading  spaces }`)).toBe(" leading  spaces ")
    expect(latexToText(String.raw`x_{\text{a_b}}`)).toBe("x_(a_b)")
    expect(latexToText(String.raw`\operatorname{arg max}(x)`)).toBe("arg max(x)")
  })

  test("preserves unknown commands and their arguments verbatim", () => {
    for (const source of [
      String.raw`\unknown`,
      String.raw`\unknown{\alpha}{x^2}`,
      String.raw`\unknown  {outer {\beta} tail} {x_2}`,
      String.raw`\unknown[option]{\alpha}`,
      String.raw`\unknown[nested[option]]{x^2}`,
      String.raw`\unknown*{\alpha}`,
      String.raw`\unknown{\{escaped\}}`,
      String.raw`\alphabeta`,
      String.raw`\constructor{x^2}`,
      String.raw`\toString{\alpha}`,
    ]) {
      expect(latexToText(source)).toBe(source)
    }
    expect(latexToText(String.raw`\unknown{\alpha} + \beta`)).toBe("\\unknown{\\alpha} + β")
    expect(latexToText(String.raw`\unknown x^2`)).toBe("\\unknown x²")
  })

  test("preserves malformed commands without consuming unrelated trailing characters", () => {
    for (const source of [
      "\\",
      "{x",
      "x}",
      "x^{2",
      "x^",
      "x_",
      "x^ + y",
      "x_ = y",
      "x^) + y",
      "x^/y",
      String.raw`\frac{x} + y`,
      String.raw`\frac{x}{y`,
      String.raw`\frac + z`,
      String.raw`\sqrt + z`,
      String.raw`\sqrt[3] + z`,
      String.raw`\sqrt[3{x}`,
      String.raw`\text + z`,
      String.raw`\text{unclosed`,
      String.raw`\mathbb + z`,
      String.raw`\unknown{unclosed`,
      String.raw`\unknown[unclosed`,
    ]) {
      expect(latexToText(source)).toBe(source)
    }
    expect(latexToText(String.raw`\frac{x} + \alpha`)).toBe("\\frac{x} + α")
    expect(latexToText(String.raw`\sqrt + \beta`)).toBe("\\sqrt + β")
    expect(latexToText("x^^2 + y")).toBe("x^² + y")
    expect(latexToText(String.raw`\frac{a}{b}tail`)).toBe("a/btail")
    expect(latexToText(String.raw`\text{hello}tail`)).toBe("hellotail")
  })

  test("bounds recursion on deeply nested groups and commands", () => {
    const groups = `${"{".repeat(10000)}x${"}".repeat(10000)} + z`
    const roots = `${String.raw`\sqrt{`.repeat(10000)}x${"}".repeat(10000)} + z`
    for (const source of [groups, roots]) {
      const result = latexToText(source)
      expect(result).toContain("x")
      expect(result.endsWith(" + z")).toBe(true)
      expect(result).toContain("{")
    }
  })

  test("handles long flat and malformed input", () => {
    const source = String.raw`\alpha + x^2 `.repeat(10000)
    expect(latexToText(source)).toBe("α + x² ".repeat(10000))
    const unmatched = `${"{".repeat(10000)}x`
    expect(latexToText(unmatched)).toBe(unmatched)
    const unknown = `${String.raw`\unknown` + "{x^2}".repeat(10000)} + y`
    expect(latexToText(unknown)).toBe(unknown)
  })
})
