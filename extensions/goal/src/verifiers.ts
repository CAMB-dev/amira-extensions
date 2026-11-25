import { createHash } from "node:crypto"
import type { AssistantMessage, ExtensionAPI, JSONSchema } from "@amira/api"
import type { GoalConfig, GoalCriterion } from "./types.ts"

export interface VerificationResult {
  ok: boolean
  summary: string
  reason: string
  details?: string
  failureHash?: string
}

const VERIFY_TIMEOUT_MS = 120_000
const MAX_VERIFY_TAIL = 2400

const VERIFIER_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "reason"],
  properties: {
    ok: { type: "boolean", description: "True only when every goal criterion is demonstrably satisfied." },
    reason: { type: "string", description: "Concise verdict and any missing items to fix next." },
    nextStep: { type: "string", description: "Specific next action if ok is false." },
  },
}

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim()
}

export function hashFailure(text: string): string {
  // Normalize line numbers/timestamps so identical recurring errors collapse cleanly.
  const normalized = text
    .replace(/\b\d+(\.\d+)?ms\b/g, "<ms>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, "<ts>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000)
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

export async function workspaceDiffHash(api: ExtensionAPI, signal: AbortSignal): Promise<string> {
  try {
    const res = await api.runCommand(["git", "status", "--porcelain"], {
      cwd: api.cwd,
      timeoutMs: 5000,
      signal,
      maxOutputChars: 32_000,
    })
    if (res.exitCode !== 0) return "no-git"
    const diff = await api.runCommand(["git", "diff", "--stat"], {
      cwd: api.cwd,
      timeoutMs: 5000,
      signal,
      maxOutputChars: 32_000,
    })
    return createHash("sha256").update(`${res.output}\n---\n${diff.output}`).digest("hex").slice(0, 16)
  } catch {
    return "no-git"
  }
}

export async function runShellCommand(
  api: ExtensionAPI,
  command: string,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; aborted: boolean }> {
  const argv =
    process.platform === "win32" ? ["pwsh", "-NoProfile", "-Command", command] : ["sh", "-c", command]
  try {
    const res = await api.runCommand(argv, {
      cwd: api.cwd,
      timeoutMs: VERIFY_TIMEOUT_MS,
      signal,
      maxOutputChars: 64_000,
    })
    return {
      exitCode: res.exitCode,
      output: res.output.trim(),
      timedOut: res.timedOut,
      aborted: res.aborted,
    }
  } catch (err) {
    // Fallback to cmd.exe if pwsh is absent on Windows.
    if (process.platform === "win32" && !signal.aborted) {
      const res = await api.runCommand(["cmd", "/d", "/s", "/c", command], {
        cwd: api.cwd,
        timeoutMs: VERIFY_TIMEOUT_MS,
        signal,
        maxOutputChars: 64_000,
      })
      return {
        exitCode: res.exitCode,
        output: res.output.trim(),
        timedOut: res.timedOut,
        aborted: res.aborted,
      }
    }
    throw err
  }
}

function parseJsonVerdict(raw: string): { ok: boolean; reason: string; nextStep?: string } | undefined {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    if (typeof parsed.ok !== "boolean") return undefined
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : ""
    const nextStep = typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : undefined
    return {
      ok: parsed.ok,
      reason: reason || (parsed.ok ? "Goal satisfied." : "Goal not yet satisfied."),
      ...(nextStep ? { nextStep } : {}),
    }
  } catch {
    return undefined
  }
}

/** Suggest 3-5 concrete acceptance criteria + optional verify command for a fuzzy goal prompt. */
export async function proposeCriteria(
  api: ExtensionAPI,
  prompt: string,
  signal: AbortSignal,
): Promise<{ criteria: GoalCriterion[]; suggestedVerify: string[] }> {
  try {
    const reply = await api.complete({
      label: "goal-plan",
      maxTokens: 500,
      signal,
      system: [
        "Break a software engineering goal into 3 to 5 concise, verifiable acceptance criteria.",
        'Return ONLY valid JSON: {"criteria": ["..."], "verifyCommands": ["..."]}.',
        "Only include verifyCommands if a standard test/typecheck/lint command clearly applies; otherwise [].",
      ].join("\n"),
      messages: [{ role: "user", content: [{ type: "text", text: `Goal: ${prompt}` }] }],
    })
    const match = reply.text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { criteria?: unknown; verifyCommands?: unknown }
      const criteria = Array.isArray(parsed.criteria)
        ? parsed.criteria
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 6)
            .map((text, idx) => ({ id: `c${idx + 1}`, text: text.trim(), done: false }))
        : []
      const suggestedVerify = Array.isArray(parsed.verifyCommands)
        ? parsed.verifyCommands
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 3)
        : []
      if (criteria.length > 0) return { criteria, suggestedVerify }
    }
  } catch {
    // Graceful fallback when model/side-call is unavailable.
  }
  return {
    criteria: [{ id: "c1", text: prompt, done: false }],
    suggestedVerify: [],
  }
}

export interface RunVerificationInput {
  api: ExtensionAPI
  config: GoalConfig
  lastMessageText: string
  completeToolCalled: boolean
  completeToolSummary?: string
  signal: AbortSignal
}

/** Composable verification pipeline: cheap deterministic checks first, short-circuit on failure. */
export async function runVerification(input: RunVerificationInput): Promise<VerificationResult> {
  const { api, config, lastMessageText, completeToolCalled, completeToolSummary, signal } = input

  // 1. Explicit completion signal gate (prevents premature status-report stops).
  if (config.requireCompleteTool && !completeToolCalled) {
    const open = config.criteria.filter((c) => !c.done).map((c) => `- [${c.id}] ${c.text}`)
    const reason = [
      "Goal is still active and you have not called `goal_complete` yet.",
      open.length ? `Remaining criteria:\n${open.join("\n")}` : `Objective: ${config.prompt}`,
      "Do not stop to summarize intermediate progress; keep executing until the goal is verified, then call `goal_complete`.",
    ].join("\n\n")
    return {
      ok: false,
      summary: "Waiting for goal_complete tool",
      reason,
      failureHash: hashFailure("missing-goal-complete"),
    }
  }

  // 2. Deterministic shell verification commands.
  const commandSummaries: string[] = []
  for (const cmd of config.verifyCommands) {
    if (signal.aborted) throw new Error("aborted")
    const res = await runShellCommand(api, cmd, signal)
    if (res.aborted || signal.aborted) throw new Error("aborted")
    if (res.timedOut || res.exitCode !== 0) {
      const tail = res.output.slice(-MAX_VERIFY_TAIL)
      const status = res.timedOut ? "timed out" : `exited with code ${res.exitCode}`
      const reason = [
        `Verification command failed (${status}): \`${cmd}\``,
        tail ? `Output (tail):\n\`\`\`\n${tail}\n\`\`\`` : "(no output)",
        "Fix the root cause, re-verify, and call `goal_complete` once everything passes.",
      ].join("\n\n")
      return {
        ok: false,
        summary: `Verify failed: ${cmd} (${status})`,
        reason,
        details: tail,
        failureHash: hashFailure(`${cmd}:${status}:${tail}`),
      }
    }
    commandSummaries.push(`PASS: ${cmd}`)
  }

  // 3. Optional semantic judge: fast LLM single-shot evaluator.
  if (config.judge === "llm") {
    if (signal.aborted) throw new Error("aborted")
    const criteriaText = config.criteria
      .map((c) => `- [${c.done ? "x" : " "}] (${c.id}) ${c.text}${c.evidence ? ` — ${c.evidence}` : ""}`)
      .join("\n")
    const reply = await api.complete({
      label: "goal-judge",
      maxTokens: 400,
      signal,
      system: [
        "You are a strict goal completion verifier. Decide whether the goal is genuinely complete.",
        'Return ONLY valid JSON: {"ok": boolean, "reason": string, "nextStep"?: string}.',
        "If anything is unverified, partially done, or hand-waved, return ok: false with concrete gaps.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Goal: ${config.prompt}`,
                criteriaText ? `Criteria:\n${criteriaText}` : "",
                commandSummaries.length ? `Shell checks:\n${commandSummaries.join("\n")}` : "",
                completeToolSummary ? `Agent completion claim: ${completeToolSummary}` : "",
                lastMessageText ? `Last assistant reply:\n${lastMessageText.slice(0, 3000)}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
      ],
    })
    const verdict = parseJsonVerdict(reply.text)
    if (!verdict) {
      return {
        ok: false,
        summary: "LLM judge returned unreadable verdict",
        reason:
          "The goal verifier could not parse the verdict. Double-check all criteria and call `goal_complete` with clear evidence.",
        failureHash: hashFailure("judge-unparseable"),
      }
    }
    if (!verdict.ok) {
      const reason = [
        `Goal verification rejected: ${verdict.reason}`,
        verdict.nextStep ? `Next step: ${verdict.nextStep}` : "",
        "Address these gaps and call `goal_complete` again when verified.",
      ]
        .filter(Boolean)
        .join("\n\n")
      return {
        ok: false,
        summary: `Judge rejected: ${verdict.reason.slice(0, 80)}`,
        reason,
        details: verdict.reason,
        failureHash: hashFailure(`llm:${verdict.reason}`),
      }
    }
  }

  // 4. Optional independent read-only verifier subagent with schema enforcement.
  if (config.judge === "verifier") {
    const session = api.session()
    if (!session?.createGroup) {
      return {
        ok: false,
        summary: "Verifier subagent unavailable",
        reason: "This host does not expose subagent groups; re-run with --judge llm or --judge none.",
        failureHash: hashFailure("no-subagent-group"),
      }
    }
    const group = session.createGroup({ name: "goal-verifier", maxAgents: 1, compact: true })
    try {
      const child = group.spawn({
        role: "goal-verifier",
        writeRoots: [],
        schema: VERIFIER_SCHEMA,
        prompt: [
          `Independently verify whether the following goal is fully achieved in ${api.cwd}.`,
          `Goal: ${config.prompt}`,
          config.criteria.length
            ? `Criteria:\n${config.criteria.map((c) => `- (${c.id}) ${c.text}`).join("\n")}`
            : "",
          commandSummaries.length ? `Shell checks already passed:\n${commandSummaries.join("\n")}` : "",
          completeToolSummary ? `Agent completion summary: ${completeToolSummary}` : "",
          "Inspect the workspace directly (read-only) and return JSON { ok, reason, nextStep? }.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      })
      const onAbort = () => child.abort("verification aborted")
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        const res = await child.result()
        if (signal.aborted) throw new Error("aborted")
        const verdict =
          res.value && typeof res.value === "object"
            ? (res.value as { ok?: boolean; reason?: string; nextStep?: string })
            : parseJsonVerdict(res.text)
        if (verdict?.ok !== true) {
          const reasonText =
            verdict?.reason?.trim() || res.text.trim() || "Verifier did not approve completion."
          return {
            ok: false,
            summary: `Verifier rejected: ${reasonText.slice(0, 80)}`,
            reason: [
              `Independent verifier rejected completion: ${reasonText}`,
              verdict?.nextStep ? `Next step: ${verdict.nextStep}` : "",
              "Fix these issues and call `goal_complete` once resolved.",
            ]
              .filter(Boolean)
              .join("\n\n"),
            details: reasonText,
            failureHash: hashFailure(`verifier:${reasonText}`),
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    } finally {
      group.end("verification finished")
    }
  }

  return {
    ok: true,
    summary: commandSummaries.length
      ? `Verified (${commandSummaries.length} checks passed)`
      : "Goal verified",
    reason: "",
  }
}
