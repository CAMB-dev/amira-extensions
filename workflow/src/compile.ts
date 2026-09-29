import { readMeta, ScriptError, type WorkflowMeta } from "./meta.ts"

/** A script turned into code the sandbox runs, with its meta. */
export interface CompiledScript {
  meta: WorkflowMeta
  /** JavaScript: the body of an async function; see the sandbox worker. */
  code: string
}

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" })

/**
 * Turns a workflow script (TypeScript) into the body of an async function. The script's top
 * level runs as that body, so it may use await and end with `return value`; an
 * `export default` (a value, or a function that is called) is its result too. Imports are
 * refused, except `import type`, which only matters to editors.
 */
export function compileScript(source: string): CompiledScript {
  const { meta, end } = readMeta(source)
  // A line after the literal that starts with "(" or "[" must not continue its statement.
  let body = `${source.slice(0, end)};${source.slice(end)}`.replace(/^﻿/, "")
  const imports: string[] = []
  body = body.replace(/^[ \t]*import\s+type\s[^;\n]*(?:from\s*["'][^"']*["'])?;?[ \t]*$/gm, "")
  for (const m of body.matchAll(/^[ \t]*import\b[^\n]*$/gm)) imports.push(m[0].trim())
  if (imports.length) {
    throw new ScriptError(
      `workflow scripts cannot import anything (${imports[0]}); they only have agent, parallel, pipeline, phase, log, args, budget and workflow`,
    )
  }
  body = body
    .replace(/^([ \t]*)export\s+default\s+/m, "$1return ")
    .replace(/^([ \t]*)export\s+(?=(const|let|var|function|async|class|interface|type|enum)\b)/gm, "$1")
  let js: string
  try {
    js = transpiler.transformSync(`async function __workflow__() {\n${body}\n}`)
  } catch (err) {
    throw new ScriptError(`the script does not compile: ${err instanceof Error ? err.message : String(err)}`)
  }
  let found: { path: string; kind: string }[] = []
  try {
    found = transpiler.scanImports(js)
  } catch {}
  const dynamic = found.find((i) => i.kind === "dynamic-import" || i.kind === "require-call")
  if (dynamic || /\bimport\s*\(|\bimport\.meta\b/.test(js)) {
    throw new ScriptError("workflow scripts cannot import modules or use import()")
  }
  // The result of a default-exported function is the script's result.
  const code = `${js}\nconst __result__ = await __workflow__();\nreturn typeof __result__ === "function" ? await __result__() : __result__;`
  return { meta, code }
}
