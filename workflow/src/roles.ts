import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Sub-agent roles (D61), read the way the built-in agent extension reads them: explorer,
 * coder and reviewer, replaced or added to by `~/.amira/agents/*.md` and
 * `<project>/.amira/agents/*.md`. Extensions cannot import each other, so this is a small copy.
 */
export interface Role {
  name: string
  model?: string
  tools?: string[]
  isolation?: "none" | "worktree"
  prompt: string
}

const READ_ONLY_TOOLS = ["read", "grep", "glob", "bash", "powershell", "web_search", "web_fetch"]
const READ_ONLY_RULE =
  "Do not change anything: no file edits, and only shell commands that read (listing files, git status/log/diff/show, printing versions). Never run commands that write, install, delete or commit."

export const BUILTIN_ROLES: Role[] = [
  {
    name: "explorer",
    tools: READ_ONLY_TOOLS,
    prompt: `You are an explorer. Investigate the codebase to answer the task.\n${READ_ONLY_RULE}`,
  },
  {
    name: "coder",
    prompt:
      "You are a coder. Implement exactly what the task specifies, matching the surrounding code's style, and nothing more. Check your change when it is practical (type check, tests, running it).",
  },
  {
    name: "reviewer",
    tools: READ_ONLY_TOOLS,
    prompt: `You are a reviewer. Review the code or change named in the task for correctness: bugs, unhandled edge cases, broken contracts, missing error handling.\n${READ_ONLY_RULE}`,
  },
]

function parseRole(text: string, file: string): Role {
  const src = text.replace(/^﻿/, "")
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src)
  const yaml = match?.[1] ?? ""
  const parsed = yaml.trim() ? Bun.YAML.parse(yaml) : {}
  const data = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  const body = match ? src.slice(match[0].length) : src
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : path.basename(file, ".md")
  const tools =
    typeof data.tools === "string"
      ? data.tools.split(/[,\s]+/).filter(Boolean)
      : Array.isArray(data.tools)
        ? data.tools.filter((t): t is string => typeof t === "string")
        : undefined
  return {
    name,
    ...(typeof data.model === "string" && data.model.trim() ? { model: data.model.trim() } : {}),
    ...(tools ? { tools } : {}),
    ...(data.isolation === "worktree" || data.isolation === "none" ? { isolation: data.isolation } : {}),
    prompt: body.trim(),
  }
}

export function loadRoles(cwd: string, home: string): Map<string, Role> {
  const roles = new Map(BUILTIN_ROLES.map((r) => [r.name, r]))
  for (const dir of [path.join(home, "agents"), path.join(cwd, ".amira", "agents")]) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(".md"))
        .sort()
    } catch {
      continue
    }
    for (const n of names) {
      try {
        const role = parseRole(readFileSync(path.join(dir, n), "utf8"), n)
        roles.set(role.name, role)
      } catch {}
    }
  }
  return roles
}
