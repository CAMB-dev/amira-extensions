const symbols: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  ast: "∗",
  star: "⋆",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  equiv: "≡",
  propto: "∝",
  ll: "≪",
  gg: "≫",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  ell: "ℓ",
  hbar: "ℏ",
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  bigcup: "⋃",
  bigcap: "⋂",
  emptyset: "∅",
  varnothing: "∅",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  lor: "∨",
  wedge: "∧",
  vee: "∨",
  to: "→",
  gets: "←",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  implies: "⇒",
  iff: "⇔",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  angle: "∠",
  perp: "⊥",
  parallel: "∥",
  langle: "⟨",
  rangle: "⟩",
  lceil: "⌈",
  rceil: "⌉",
  lfloor: "⌊",
  rfloor: "⌋",
  vert: "|",
  Vert: "‖",
  lbrace: "{",
  rbrace: "}",
  backslash: "\\",
  degree: "°",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  arcsin: "arcsin",
  arccos: "arccos",
  arctan: "arctan",
  sinh: "sinh",
  cosh: "cosh",
  log: "log",
  ln: "ln",
  exp: "exp",
  lim: "lim",
  min: "min",
  max: "max",
  det: "det",
  quad: "  ",
  qquad: "    ",
  enspace: " ",
  thinspace: " ",
  ",": " ",
  ";": " ",
  ":": " ",
  " ": " ",
  "!": "",
  "{": "{",
  "}": "}",
  $: "$",
  "%": "%",
  "&": "&",
  _: "_",
  "#": "#",
  "\\": "\n",
}

function characterMap(from: string, to: string): Map<string, string> {
  const values = [...to]
  return new Map([...from].map((char, index) => [char, values[index]!]))
}

const superscripts = characterMap(
  "0123456789+-=()abcdefghijklmnoprstuvwxyz",
  "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ",
)
const subscripts = characterMap(
  "0123456789+-=()aehijklmnoprstuvxβγρφχ",
  "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ",
)
const blackboard = characterMap("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ")

function script(text: string, marker: string): string {
  const map = marker === "^" ? superscripts : subscripts
  const chars = [...text]
  return chars.every((char) => map.has(char))
    ? chars.map((char) => map.get(char)).join("")
    : `${marker}(${text})`
}

function operand(text: string): string {
  // Multi-character operands (including nested fractions) must retain their grouping.
  return /^[\p{L}\p{N}]$/u.test(text) || /^\d+(?:\.\d+)?$/.test(text) ? text : `(${text})`
}

interface Token {
  text: string
  end: number
}

interface Group {
  start: number
  end: number
}

/** Convert math source, not Markdown. Unsupported syntax is retained rather than guessed. */
export function latexToText(source: string): string {
  // Index braces once, respecting escaped braces. A depth limit below bounds recursive rendering.
  const braces = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") {
      i++
    } else if (source[i] === "{") {
      stack.push(i)
    } else if (source[i] === "}" && stack.length) {
      braces.set(stack.pop()!, i)
    }
  }

  function skipSpace(start: number, end: number): number {
    while (start < end && /\s/.test(source[start]!)) start++
    return start
  }

  function group(start: number, end: number): Group | undefined {
    start = skipSpace(start, end)
    const close = braces.get(start)
    if (close === undefined || close >= end) return undefined
    return { start, end: close + 1 }
  }

  function bracketEnd(start: number, end: number): number | undefined {
    let depth = 0
    for (let i = start; i < end; i++) {
      if (source[i] === "\\") {
        i++
      } else if (source[i] === "{") {
        const close = braces.get(i)
        if (close === undefined || close >= end) return undefined
        i = close
      } else if (source[i] === "[") {
        depth++
      } else if (source[i] === "]" && --depth === 0) {
        return i + 1
      }
    }
    return undefined
  }

  function rawCommand(start: number, commandEnd: number, end: number): Token {
    let cursor = commandEnd
    if (source[cursor] === "*") cursor++
    // An unknown command owns adjacent arguments, but not the following text or operators.
    while (cursor < end) {
      const next = skipSpace(cursor, end)
      if (source[next] === "{") {
        const close = braces.get(next)
        cursor = close === undefined || close >= end ? end : close + 1
      } else if (source[next] === "[") {
        cursor = bracketEnd(next, end) ?? end
      } else {
        break
      }
    }
    return { text: source.slice(start, cursor), end: cursor }
  }

  function contents(value: Group, depth: number): string {
    return render(value.start + 1, value.end - 1, depth + 1)
  }

  function atom(start: number, end: number, depth: number): Token {
    const char = source[start]!
    if (char === "{") {
      const close = braces.get(start)
      if (close === undefined || close >= end) return { text: source.slice(start, end), end }
      return { text: render(start + 1, close, depth + 1), end: close + 1 }
    }
    if (char !== "\\") {
      const text = String.fromCodePoint(source.codePointAt(start)!)
      return { text, end: start + text.length }
    }

    let cursor = start + 1
    if (cursor === end) return { text: "\\", end }
    if (/[a-zA-Z]/.test(source[cursor]!)) {
      while (cursor < end && /[a-zA-Z]/.test(source[cursor]!)) cursor++
    } else {
      cursor++
    }
    const name = source.slice(start + 1, cursor)
    if (Object.hasOwn(symbols, name)) return { text: symbols[name]!, end: cursor }
    if (name === "left" || name === "right") {
      const next = skipSpace(cursor, end)
      return { text: "", end: source[next] === "." ? next + 1 : cursor }
    }

    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = group(cursor, end)
      const denominator = numerator && group(numerator.end, end)
      if (numerator && denominator) {
        return {
          text: `${operand(contents(numerator, depth))}/${operand(contents(denominator, depth))}`,
          end: denominator.end,
        }
      }
    } else if (name === "sqrt") {
      let next = skipSpace(cursor, end)
      let index: string | undefined
      if (source[next] === "[") {
        const close = bracketEnd(next, end)
        if (close === undefined) return rawCommand(start, cursor, end)
        index = render(next + 1, close - 1, depth + 1)
        next = close
      }
      const value = group(next, end)
      if (value) {
        const prefix = index === undefined ? "" : script(index, "^")
        return { text: `${prefix}√${operand(contents(value, depth))}`, end: value.end }
      }
    } else if (name === "text" || name === "operatorname") {
      const value = group(cursor, end)
      if (value) {
        // Text arguments are literal: underscores, carets and command names are not math.
        const text = source.slice(value.start + 1, value.end - 1).replace(/\\([{}%$&#_\\])/g, "$1")
        return { text, end: value.end }
      }
    } else if (name === "mathbb") {
      const value = group(cursor, end)
      if (value) {
        const text = contents(value, depth)
        if ([...text].every((char) => blackboard.has(char))) {
          return { text: [...text].map((char) => blackboard.get(char)).join(""), end: value.end }
        }
      }
    } else if (["mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal"].includes(name)) {
      const value = group(cursor, end)
      if (value) return { text: contents(value, depth), end: value.end }
    }
    return rawCommand(start, cursor, end)
  }

  function render(start: number, end: number, depth: number): string {
    // Preserve the remaining source verbatim instead of risking a stack overflow.
    if (depth >= 64) return source.slice(start, end)
    const output: string[] = []
    let cursor = start
    while (cursor < end) {
      const char = source[cursor]!
      if (char === "^" || char === "_") {
        const next = skipSpace(cursor + 1, end)
        // A missing argument must not swallow an operator, closing brace, or another script.
        if (next < end && !/[}\])^_+\-=,;:$/*<>|&!?]/.test(source[next]!)) {
          if (source[next] !== "{" || braces.has(next)) {
            const value = atom(next, end, depth)
            output.push(script(value.text, char))
            cursor = value.end
            continue
          }
        }
        output.push(char)
        cursor++
      } else {
        const value = atom(cursor, end, depth)
        output.push(value.text)
        cursor = value.end
      }
    }
    return output.join("")
  }

  return render(0, source.length, 0)
}
