import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** Which shell runs a hook's command: bash (Git Bash on Windows) or PowerShell. */
export type ShellKind = "bash" | "powershell"

/** How to start one command: argv, and variables the shell itself needs. */
export interface ShellLaunch {
  argv: string[]
  /** Added to the hook's environment, e.g. Git Bash's PATH. */
  env: Record<string, string>
  /** What actually runs it, for /hooks: "bash", "powershell (Git Bash not found)". */
  label: string
}

export interface ShellDeps {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  exists?: (p: string) => boolean
  /** Looks a program up on PATH. */
  which?: (name: string) => string | null
}

/**
 * Starts `command` in the shell the bash tool uses: Git Bash on Windows (PowerShell when it is
 * missing), bash (or sh) elsewhere; or PowerShell when asked. Nothing is spawned to find them.
 */
export function shellLaunch(kind: ShellKind, command: string, deps: ShellDeps = {}): ShellLaunch {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const which = deps.which ?? ((name: string) => Bun.which(name))
  if (kind === "bash") {
    if (platform !== "win32") {
      const bash = ["/bin/bash", "/usr/bin/bash"].find(exists) ?? which("bash")
      return { argv: [bash ?? "/bin/sh", "-c", command], env: {}, label: bash ? "bash" : "sh" }
    }
    const found = findGitBash(deps.env ?? process.env, exists, which)
    if (found) {
      return { argv: [found.bash, "-c", command], env: gitBashEnv(found.root, deps.env), label: "bash" }
    }
    return { ...powershell(command, platform, which), label: "powershell (Git Bash not found)" }
  }
  return { ...powershell(command, platform, which), label: "powershell" }
}

function powershell(command: string, platform: NodeJS.Platform, which: (name: string) => string | null) {
  const exe = which("pwsh") ?? (platform === "win32" ? (which("powershell") ?? "powershell.exe") : "pwsh")
  // -EncodedCommand takes the script as base64 UTF-16LE, so no quoting can break it.
  const encoded = Buffer.from(command, "utf16le").toString("base64")
  return {
    argv: [
      exe,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    env: {},
  }
}

/** WSL's bash.exe (System32) and the Store alias (WindowsApps) are never Git Bash. */
function rejected(p: string): boolean {
  const lower = p.replaceAll("/", "\\").toLowerCase()
  return lower.includes("\\system32\\") || lower.includes("\\windowsapps\\")
}

/** The real bash (usr\bin\bash.exe) and Git's root, when `root` is a Git for Windows install. */
function bashIn(root: string, exists: (p: string) => boolean): { bash: string; root: string } | undefined {
  const bash = path.win32.join(root, "usr", "bin", "bash.exe")
  return exists(bash) && !rejected(bash) ? { bash, root } : undefined
}

/**
 * Git Bash: $AMIRA_BASH, then the Git install that git.exe on PATH belongs to, then the usual
 * install places.
 */
export function findGitBash(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
  which: (name: string) => string | null,
): { bash: string; root?: string } | undefined {
  const override = env.AMIRA_BASH
  if (override && exists(override) && !rejected(override)) {
    const p = path.win32.normalize(override)
    const lower = p.toLowerCase()
    // Git's bin\bash.exe launcher: run the real one, with the environment the launcher gives it.
    if (lower.endsWith("\\bin\\bash.exe") && !lower.endsWith("\\usr\\bin\\bash.exe")) {
      const found = bashIn(path.win32.dirname(path.win32.dirname(p)), exists)
      if (found) return found
    }
    if (lower.endsWith("\\usr\\bin\\bash.exe"))
      return { bash: p, root: path.win32.resolve(p, "..", "..", "..") }
    return { bash: p }
  }
  const git = which("git")
  if (git && !rejected(git)) {
    // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe
    let dir = path.win32.dirname(git)
    for (let i = 0; i < 3; i++) {
      dir = path.win32.dirname(dir)
      const found = bashIn(dir, exists)
      if (found) return found
    }
  }
  const roots = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "Git"),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "Git"),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "Git"),
    env.USERPROFILE && path.win32.join(env.USERPROFILE, "scoop", "apps", "git", "current"),
    "C:\\Program Files\\Git",
  ]
  for (const root of roots) {
    const found = root ? bashIn(root, exists) : undefined
    if (found) return found
  }
  return undefined
}

function envKey(env: Record<string, string | undefined>, name: string): string {
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name
}

/** What Git's bin\bash.exe launcher adds for usr\bin\bash.exe: its tools on PATH, MSYSTEM. */
export function gitBashEnv(
  root: string | undefined,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!root) return {}
  const pathKey = envKey(base, "PATH")
  const prefix = [
    path.win32.join(root, "mingw64", "bin"),
    path.win32.join(root, "usr", "bin"),
    path.win32.join(homedir(), "bin"),
  ]
  const out: Record<string, string> = { [pathKey]: [...prefix, base[pathKey]].filter(Boolean).join(";") }
  if (base[envKey(base, "MSYSTEM")] === undefined) out.MSYSTEM = "MINGW64"
  return out
}
