import { anchor } from "./markdown.ts"
import {
  type Entry,
  formatDuration,
  formatTime,
  type ImagePart,
  type Part,
  type SubagentSection,
  type ToolCall,
  type Transcript,
  usageLine,
} from "./transcript.ts"

/**
 * The transcript as one self-contained HTML file: styles and the few lines of script are
 * inline, images are data URLs, nothing is loaded from elsewhere. Replies are rendered from
 * Markdown by a small renderer that escapes everything, so no text in the session becomes
 * markup. Tool calls, thinking and sub-agents are collapsible.
 */
export function renderHtml(t: Transcript): string {
  const facts: string[] = [`<span>${esc(t.cwd)}</span>`]
  if (t.createdAt !== undefined) facts.push(`<span>Started ${esc(formatTime(t.createdAt))}</span>`)
  facts.push(`<span>Exported ${esc(formatTime(t.exportedAt))}</span>`)
  if (t.models.length) facts.push(`<span>${t.models.map((m) => `<code>${esc(m)}</code>`).join(", ")}</span>`)
  facts.push(`<span>${esc(usageLine(t.usage))}</span>`)
  if (t.subagents.length)
    facts.push(
      `<span><a href="#sub-agents">${t.subagents.length} sub-agent${t.subagents.length === 1 ? "" : "s"}</a></span>`,
    )
  const subagents = t.subagents.length
    ? `<section class="subagents"><h2 id="sub-agents">Sub-agents</h2>${t.subagents.map(renderSubagent).join("\n")}</section>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Amira share extension">
<title>Amira session ${esc(t.sessionId)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Amira session <code>${esc(t.sessionId)}</code></h1>
<p class="facts">${facts.join("")}</p>
<p class="toolbar"><button type="button" data-open="1">Expand all</button><button type="button" data-open="0">Collapse all</button></p>
</header>
<main>
${renderEntries(t.entries)}
${subagents}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`
}

function renderEntries(entries: Entry[]): string {
  return entries.map(renderEntry).join("\n")
}

function renderEntry(e: Entry): string {
  if (e.kind === "user") {
    const images = e.images.map(image).join("")
    if (e.display) {
      const note = e.note ? `<p class="note">${esc(e.note)}</p>` : ""
      return `<article class="msg user"><div class="who">You</div><p class="typed">${esc(e.display)}</p>${note}${collapsible("Full message", `<pre class="plain">${esc(e.text)}</pre>`)}${images}</article>`
    }
    return `<article class="msg user"><div class="who">You</div><div class="plain">${esc(e.text)}</div>${images}</article>`
  }
  if (e.kind === "notice") {
    return `<article class="msg notice"><div class="who">Notice · ${esc(e.origin)}</div>${e.display ? `<p>${esc(e.display)}</p>` : ""}${collapsible("Message", `<div class="md">${markdownToHtml(e.text)}</div>`)}</article>`
  }
  const stop = e.stopReason ? `<p class="note">Stopped: ${esc(e.stopReason)}</p>` : ""
  const model = e.model ? ` <code>${esc(e.model)}</code>` : ""
  return `<article class="msg assistant"><div class="who">Assistant${model}</div>${e.parts.map(renderPart).join("")}${stop}</article>`
}

function renderPart(p: Part): string {
  if (p.kind === "text") return `<div class="md">${markdownToHtml(p.text)}</div>`
  if (p.kind === "thinking")
    return collapsible("Thinking", `<div class="md thinking">${markdownToHtml(p.text)}</div>`, "thinking")
  return renderTool(p.call)
}

function renderTool(c: ToolCall): string {
  const state = c.result === undefined ? "pending" : c.result.isError ? "error" : "ok"
  const mark =
    state === "error"
      ? `<span class="bad">failed</span>`
      : state === "pending"
        ? `<span class="muted">no result</span>`
        : ""
  const summary = `<span class="tool-name">${esc(c.name)}</span>${c.summary ? ` <span class="tool-sum">${esc(c.summary)}</span>` : ""} ${mark}`
  const body: string[] = []
  if (c.args !== "{}") body.push(`<div class="label">Arguments</div><pre><code>${esc(c.args)}</code></pre>`)
  for (const s of c.subagents)
    body.push(`<p class="sublink">Sub-agent: <a href="#${anchor(s.id)}">${esc(s.title)}</a></p>`)
  if (c.result) {
    body.push(
      `<div class="label">${c.result.isError ? "Error" : "Result"}</div><pre><code>${esc(c.result.text || "(empty)")}</code></pre>`,
    )
    body.push(...c.result.images.map(image))
  }
  return collapsible(summary, body.join(""), `tool ${state}`, true)
}

function renderSubagent(s: SubagentSection): string {
  const facts = [s.role, s.status, s.model ?? "", usageLine(s.usage)]
  if (s.durationMs !== undefined) facts.push(formatDuration(s.durationMs))
  const error = s.error ? `<p class="bad">${esc(s.error)}</p>` : ""
  const task = s.task ? collapsible("Task", `<div class="md">${markdownToHtml(s.task)}</div>`) : ""
  const body = s.entries.length
    ? renderEntries(s.entries)
    : `<p class="muted">No conversation was recorded.</p>`
  const indent = Math.min(3, Math.max(0, s.depth - 1))
  return `<details class="subagent depth-${indent}" id="${anchor(s.id)}"><summary><span class="sub-title">${esc(s.title)}</span> <span class="muted">${esc(facts.filter(Boolean).join(" · "))}</span></summary>${error}${task}<div class="sub-body">${body}</div></details>`
}

function collapsible(summary: string, body: string, cls = "", summaryIsHtml = false): string {
  return `<details class="${cls}"><summary>${summaryIsHtml ? summary : esc(summary)}</summary>${body}</details>`
}

function image(img: ImagePart): string {
  // Only image types a browser shows inline; the data is base64 and cannot break out of the attribute.
  if (!/^image\/(png|jpeg|gif|webp)$/.test(img.mimeType) || !/^[A-Za-z0-9+/=\s]*$/.test(img.data))
    return `<p class="muted">[image: ${esc(img.mimeType)}]</p>`
  return `<img class="img" alt="" src="data:${img.mimeType};base64,${img.data.replace(/\s/g, "")}">`
}

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * A small Markdown renderer for replies: fenced code, headings, lists, quotes, rules, tables
 * and paragraphs, with inline code, bold, italic, strike and links. Text is escaped before any
 * markup is added; links keep only http(s), mailto and relative targets.
 */
export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  const isBlank = (l: string | undefined) => l === undefined || !l.trim()
  while (i < lines.length) {
    const line = lines[i]!
    const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
    if (fenceOpen) {
      const marker = fenceOpen[2]!
      const lang = fenceOpen[3] ?? ""
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!)
      i++
      const cls = lang ? ` class="lang-${esc(lang)}"` : ""
      out.push(`<pre><code${cls}>${esc(body.join("\n"))}</code></pre>`)
      continue
    }
    if (isBlank(line)) {
      i++
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      // Replies' headings sit under the page's own, so they start at h3.
      const level = Math.min(6, heading[1]!.length + 2)
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>")
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""))
      out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!))
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      )
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
    if (item.test(line)) {
      const ordered = /\d/.test(item.exec(line)![2]!)
      const items: string[] = []
      while (i < lines.length) {
        const m = item.exec(lines[i]!)
        if (m) {
          items.push(m[3]!)
          i++
          continue
        }
        // A continuation line of the item before (indented, not blank).
        if (!isBlank(lines[i]) && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1] += `\n${lines[i]!.trim()}`
          i++
          continue
        }
        break
      }
      const tag = ordered ? "ol" : "ul"
      out.push(
        `<${tag}>${items
          .map((t) => {
            const task = /^\[([ xX✓])\]\s+(.*)$/s.exec(t)
            if (task) return `<li class="task">${task[1] === " " ? "[ ]" : "[✓]"} ${inline(task[2]!)}</li>`
            return `<li>${inline(t)}</li>`
          })
          .join("")}</${tag}>`,
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(\s{0,3})(`{3,}|~{3,})/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s{0,3}>/.test(lines[i]!) &&
      !(para.length && item.test(lines[i]!))
    )
      para.push(lines[i++]!)
    out.push(`<p>${para.map(inline).join("<br>")}</p>`)
  }
  return out.join("\n")
}

/** Sets code spans aside while the rest of a line is rendered (a private-use character). */
const MARK = "\uE000"
const MARKED = /\uE000(\d+)\uE000/g

/** Inline Markdown over escaped text; code spans are set aside first so nothing inside them changes. */
function inline(text: string): string {
  const codes: string[] = []
  let s = text.replaceAll(MARK, "").replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => {
    codes.push(`<code>${esc(code.trim() ? code.replace(/^ (.*) $/, "$1") : code)}</code>`)
    return `${MARK}${codes.length - 1}${MARK}`
  })
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, label: string, href: string) => {
    const url = href.replace(/&amp;/g, "&")
    if (
      !/^(https?:|mailto:|#|\.{0,2}\/|[\w-]+(\.[\w-]+)*(\/|$))/i.test(url) ||
      /^(javascript|data|vbscript):/i.test(url)
    )
      return `${label} (${href})`
    return `<a href="${esc(url)}" rel="noopener noreferrer">${label}</a>`
  })
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, "$1<em>$2</em>")
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
  return s.replace(MARKED, (_m, n: string) => codes[Number(n)] ?? "")
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--card:#ffffff;--code:#f3f4f6;--accent:#8250df;--user:#0969da;--ok:#1a7f37;--bad:#cf222e;--notice:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--code:#1f242c;--accent:#b392f0;--user:#58a6ff;--ok:#3fb950;--bad:#f85149;--notice:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Microsoft YaHei",sans-serif}
header,main{max-width:920px;margin:0 auto;padding:0 16px}
header{padding-top:28px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h1{font-size:1.35rem;margin:0 0 6px}
.facts{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--muted);font-size:.85rem;margin:0}
.toolbar{margin:10px 0 4px;display:flex;gap:8px}
button{font:inherit;font-size:.8rem;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}
main{padding-bottom:60px}
.msg{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:10px 16px;margin:16px 0;overflow-wrap:anywhere}
.msg.user{border-left-color:var(--user)}
.msg.assistant{border-left-color:var(--accent)}
.msg.notice{border-left-color:var(--notice);font-size:.92rem}
.who{font-size:.78rem;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.who code{text-transform:none;font-weight:400}
.plain{white-space:pre-wrap}
.typed{font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;margin:4px 0}
.note,.muted{color:var(--muted);font-size:.85rem}
.bad{color:var(--bad)}
code{font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;font-size:.88em;background:var(--code);border-radius:4px;padding:.1em .3em}
pre{background:var(--code);border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:.85rem;line-height:1.45;max-height:32rem}
pre code{background:none;padding:0;font-size:inherit}
pre.plain{white-space:pre-wrap}
.md h3,.md h4,.md h5,.md h6{margin:14px 0 6px;font-size:1rem}
.md p{margin:8px 0}
.md table{border-collapse:collapse;margin:8px 0;display:block;overflow-x:auto}
.md th,.md td{border:1px solid var(--line);padding:4px 10px}
.md blockquote{margin:8px 0;padding:0 12px;border-left:3px solid var(--line);color:var(--muted)}
.md li.task{list-style:none;margin-left:-1.2em}
a{color:var(--user)}
details{margin:6px 0;border:1px solid var(--line);border-radius:6px;padding:0 10px}
details>summary{cursor:pointer;padding:5px 0;color:var(--muted);font-size:.88rem;list-style-position:inside}
details[open]>summary{border-bottom:1px solid var(--line);margin-bottom:6px}
details.tool>summary{font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool-name{color:var(--fg);font-weight:600}
details.tool.error{border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}
details.thinking .md{color:var(--muted);font-style:italic}
.label{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-top:6px}
.img{max-width:100%;border-radius:6px;border:1px solid var(--line);margin:6px 0}
.subagents h2{font-size:1.1rem;margin-top:36px;padding-top:12px;border-top:1px solid var(--line)}
details.subagent{background:var(--card);border-left:3px solid var(--accent);margin:10px 0;padding:0 14px}
details.subagent>summary{color:var(--fg);font-size:.95rem}
details.subagent.depth-1{margin-left:20px}
details.subagent.depth-2,details.subagent.depth-3{margin-left:40px}
.sub-title{font-weight:600}
.sub-body .msg{margin:10px 0;box-shadow:none}
@media print{.toolbar{display:none}}
`

const SCRIPT = `
for (const b of document.querySelectorAll("button[data-open]")) {
  b.addEventListener("click", () => {
    const open = b.dataset.open === "1"
    for (const d of document.querySelectorAll("details")) d.open = open
  })
}
if (location.hash) {
  const target = document.getElementById(location.hash.slice(1))
  if (target && target.tagName === "DETAILS") target.open = true
}
for (const a of document.querySelectorAll('a[href^="#subagent-"]')) {
  a.addEventListener("click", () => {
    const target = document.getElementById(a.getAttribute("href").slice(1))
    if (target) target.open = true
  })
}
`
