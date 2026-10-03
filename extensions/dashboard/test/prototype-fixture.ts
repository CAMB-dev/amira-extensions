import { emptyUsage, type TraceSummary, type ViewLine } from "@amira/api"
import type { DashboardDetails, DashboardFile, DashboardSnapshot, DashboardSource } from "../src/source.ts"
import type { DashboardViewData } from "../src/view.ts"

function changedFile(path: string, diff: string): DashboardFile {
  const lines = diff.trim().split("\n")
  return {
    path,
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
    diff: lines.map(
      (text): ViewLine => ({
        kind: text.startsWith("@@")
          ? "diff-hunk"
          : text.startsWith("+")
            ? "diff-add"
            : text.startsWith("-")
              ? "diff-remove"
              : "text",
        text: /^[+-]/.test(text) ? text.slice(1) : text,
      }),
    ),
  }
}

/** Frozen workflow scenario from the orchestration dashboard prototype, not a live simulation. */
export function prototypeFixture(): {
  data: DashboardViewData
  snapshot: DashboardSnapshot
  details: Record<string, DashboardDetails>
  now: number
} {
  const startedAt = Date.parse("2026-10-03T10:12:31.000Z")
  const codeStartedAt = startedAt + 21_000
  const now = codeStartedAt + 38_000
  const request = "Add refresh token rotation and invalidate on logout"
  const snapshot: DashboardSnapshot = {
    workspace: "~/work/amira",
    phases: [
      {
        id: "request",
        name: "User request",
        status: "done",
        startedAt,
        durationMs: 0,
        description: request,
        ref: "req-7f3a",
        groups: [],
      },
      {
        id: "plan",
        name: "Plan",
        status: "done",
        startedAt,
        durationMs: 21_000,
        stepCount: 3,
        ref: "plan-9c1b",
        groups: [
          {
            id: "planner",
            name: "Plan Agent",
            status: "done",
            startedAt,
            durationMs: 21_000,
            stepCount: 3,
            agents: [
              {
                id: "planner",
                name: "planner",
                task: "task-plan",
                status: "done",
                startedAt,
                durationMs: 21_000,
                cost: 0.0012,
                progress: 1,
                files: [],
                actions: ["request-changes"],
              },
            ],
          },
        ],
      },
      {
        id: "code",
        name: "Code Agent ×3",
        status: "running",
        startedAt: codeStartedAt,
        description: request,
        ref: "job-3a9d",
        groups: [
          {
            id: "workers",
            name: "Code Agent",
            status: "running",
            startedAt: codeStartedAt,
            description: request,
            ref: "job-3a9d",
            agents: [
              {
                id: "worker-1",
                name: "worker-1",
                task: "task-auth-middleware",
                status: "running",
                startedAt: codeStartedAt,
                cost: 0.0042,
                progress: 0.7,
                language: "TypeScript",
                files: [
                  changedFile(
                    "src/auth/refresh-token.ts",
                    `
@@ -1,12 +1,34 @@
 import { db } from "../db"
-import { signToken } from "./jwt"
+import { signToken, verifyToken } from "./jwt"
+import { uuidv7 } from "../util/uuid"
+import { TokenReuseError } from "./errors"

 export interface RefreshToken {
   userId: string
+  jti: string
+  family: string
   expiresAt: Date
 }

+/** Issues a new refresh token and revokes the one it replaces. */
+export async function rotateRefreshToken(old: string): Promise<string> {
+  const claims = await verifyToken(old)
+  const row = await db.refreshTokens.findByJti(claims.jti)
+  if (!row || row.revokedAt) {
+    // Reuse of a revoked token: revoke the whole family.
+    await db.refreshTokens.revokeFamily(claims.family)
+    throw new TokenReuseError(claims.sub)
+  }
+  await db.refreshTokens.revoke(claims.jti)
+  const jti = uuidv7()
+  await db.refreshTokens.insert({ jti, userId: claims.sub, family: claims.family })
+  return signToken({ sub: claims.sub, jti, family: claims.family })
+}
+
 export function issueRefreshToken(userId: string): string {
-  return signToken({ sub: userId })
+  const jti = uuidv7()
+  void db.refreshTokens.insert({ jti, userId, family: jti })
+  return signToken({ sub: userId, jti, family: jti })
 }`,
                  ),
                  changedFile(
                    "src/auth/logout.ts",
                    `
@@ -4,9 +4,13 @@ import { clearSession } from "./session"

 export async function logout(req: Request): Promise<Response> {
   const session = await clearSession(req)
-  // TODO: refresh tokens stay valid until they expire
+  const refresh = readRefreshCookie(req)
+  if (refresh) {
+    const { jti } = decodeToken(refresh)
+    await db.refreshTokens.revoke(jti)
+  }
   return new Response(null, {
     status: 204,
-    headers: { "set-cookie": expireCookie("sid") },
+    headers: [["set-cookie", expireCookie("sid")], ["set-cookie", expireCookie("rt")]],
   })
 }`,
                  ),
                  changedFile(
                    "test/auth/refresh-token.test.ts",
                    `
@@ -0,0 +1,22 @@
+import { expect, test } from "bun:test"
+import { issueRefreshToken, rotateRefreshToken } from "../../src/auth/refresh-token"
+
+test("rotates on refresh", async () => {
+  const first = issueRefreshToken("u1")
+  const second = await rotateRefreshToken(first)
+  expect(second).not.toBe(first)
+})
+
+test("revokes the family when a revoked token is reused", async () => {
+  const first = issueRefreshToken("u1")
+  await rotateRefreshToken(first)
+  await expect(rotateRefreshToken(first)).rejects.toThrow("TokenReuseError")
+})
+
+test("logout revokes by jti", async () => {
+  const token = issueRefreshToken("u1")
+  await logout(requestWithCookie("rt", token))
+  await expect(rotateRefreshToken(token)).rejects.toThrow()
+})`,
                  ),
                ],
                actions: ["pause", "stop", "request-changes"],
              },
              {
                id: "worker-2",
                name: "worker-2",
                task: "task-token-repo",
                status: "done",
                startedAt: codeStartedAt,
                durationMs: 32_000,
                cost: 0.0031,
                progress: 1,
                language: "PostgreSQL",
                files: [
                  changedFile(
                    "db/migrations/20240512_add_jti.sql",
                    `
@@ -0,0 +1,14 @@
+-- Refresh token rotation: every token gets an id (jti) and a family.
+ALTER TABLE refresh_tokens
+  ADD COLUMN jti uuid,
+  ADD COLUMN family uuid,
+  ADD COLUMN revoked_at timestamptz;
+
+UPDATE refresh_tokens SET jti = gen_random_uuid(), family = gen_random_uuid()
+  WHERE jti IS NULL;
+
+ALTER TABLE refresh_tokens ALTER COLUMN jti SET NOT NULL;
+
+CREATE UNIQUE INDEX CONCURRENTLY refresh_tokens_jti_idx ON refresh_tokens (jti);
+CREATE INDEX CONCURRENTLY refresh_tokens_family_idx ON refresh_tokens (family)
+  WHERE revoked_at IS NULL;`,
                  ),
                ],
                actions: ["request-changes"],
              },
              {
                id: "worker-3",
                name: "worker-3",
                task: "更新登录流程文档",
                status: "running",
                startedAt: codeStartedAt,
                cost: 0.0021,
                progress: 0.5,
                language: "Markdown",
                files: [],
                actions: ["pause", "stop", "request-changes"],
              },
            ],
          },
        ],
      },
      {
        id: "integrate",
        name: "Integrate",
        status: "queued",
        description: "queued",
        ref: "int-a1d2",
        groups: [
          {
            id: "integrator",
            name: "Integrate Agent",
            status: "queued",
            agents: [
              {
                id: "integrator",
                name: "integrator",
                task: "task-merge-workers",
                status: "queued",
                cost: 0,
                language: "git",
                files: [],
                actions: [],
              },
            ],
          },
        ],
      },
      {
        id: "check",
        name: "Check",
        status: "queued",
        description: "waiting",
        ref: "chk-5e7f",
        groups: [
          {
            id: "checker",
            name: "Check Agent",
            status: "queued",
            agents: [
              {
                id: "checker",
                name: "checker",
                task: "task-check",
                status: "queued",
                cost: 0,
                files: [],
                actions: [],
              },
            ],
          },
        ],
      },
      {
        id: "complete",
        name: "Complete",
        status: "queued",
        description: "waiting",
        ref: "cmp-b8c3",
        groups: [],
      },
    ],
  }
  const usage = { ...emptyUsage(), input: 2_400, output: 600, cost: 0.0042 }
  const stats: TraceSummary = {
    start: codeStartedAt,
    end: now,
    wallTimeMs: 38_000,
    modelTimeMs: 20_000,
    modelWaitMs: 2_000,
    modelStreamMs: 18_000,
    modelUnknownMs: 0,
    toolTimeMs: 18_000,
    toolDurationMs: 18_000,
    approvalWaitMs: 0,
    idleMs: 0,
    usage,
    subagentUsage: emptyUsage(),
    totalUsage: { ...usage },
    tools: {},
    failures: [],
    retries: 0,
    subagents: [],
  }
  const details: Record<string, DashboardDetails> = {
    planner: {
      summary: [{ kind: "text", text: "Read the auth module and split the change into three worker tasks." }],
      logs: [{ kind: "text", text: "todo_write 3 tasks" }],
      steps: [
        { text: "Read the auth module", status: "done" },
        { text: "Draft the plan", status: "done" },
        { text: "Split into worker tasks", status: "done" },
      ],
    },
    "worker-1": {
      summary: [{ kind: "text", text: "Add rotateRefreshToken() and persist jti. Update logout to revoke." }],
      logs: [
        { kind: "text", text: "read_file src/auth/refresh-token.ts" },
        { kind: "text", text: "edit src/auth/refresh-token.ts" },
        { kind: "text", text: "edit src/auth/logout.ts" },
        { kind: "text", text: "edit test/auth/refresh-token.test.ts" },
      ],
      steps: [
        { text: "Add rotateRefreshToken() helper", status: "done" },
        { text: "Persist jti to refresh_tokens", status: "done" },
        { text: "Update logout to revoke tokens by jti", status: "done" },
        { text: "Add unit tests", status: "running" },
        { text: "Run lint and typecheck", status: "queued" },
      ],
      notes: [
        { kind: "text", text: "Using uuid v7 for jti. Revocation via jti blacklist + token families." },
      ],
      stats,
    },
    "worker-2": {
      summary: [{ kind: "text", text: "Add jti column and index for refresh_tokens." }],
      logs: [
        { kind: "text", text: "bash bun run db:migrate --dry-run" },
        { kind: "success", text: "20240512_add_jti.sql  ok (no transaction)" },
      ],
      steps: [
        { text: "Add jti and family columns", status: "done" },
        { text: "Backfill existing rows", status: "done" },
        { text: "Add indexes", status: "done" },
        { text: "Dry-run the migration", status: "done" },
      ],
    },
    "worker-3": {
      summary: [{ kind: "text", text: "在登录流程文档里补充刷新令牌轮换和退出登录的说明。" }],
      logs: [{ kind: "text", text: "read_file docs/auth/登录流程.md" }],
      steps: [
        { text: "阅读现有文档", status: "done" },
        { text: "补充刷新令牌轮换说明", status: "running" },
        { text: "更新时序图说明", status: "queued" },
      ],
    },
    integrator: {
      summary: [
        { kind: "text", text: "Merge the three worktrees into the run branch and resolve conflicts." },
      ],
      logs: [],
      steps: [
        { text: "Merge worker-1", status: "queued" },
        { text: "Merge worker-2", status: "queued" },
        { text: "Merge worker-3", status: "queued" },
        { text: "Resolve conflicts", status: "queued" },
      ],
    },
    checker: {
      summary: [
        {
          kind: "text",
          text: "Run typecheck and tests in parallel, fix what breaks, review the combined diff.",
        },
      ],
      logs: [],
      steps: [
        { text: "Typecheck and test", status: "queued" },
        { text: "Fix failures", status: "queued" },
        { text: "Review the combined diff", status: "queued" },
      ],
    },
  }
  const source: DashboardSource = {
    id: "prototype",
    label: "Refresh token rotation",
    snapshot: () => snapshot,
    details: (id) => details[id],
    act: (_id, action) => `Accepted ${action}.`,
  }
  const data: DashboardViewData = { source, tab: "summary" }
  return { data, snapshot, details, now }
}
