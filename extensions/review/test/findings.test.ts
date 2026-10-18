import { afterEach, describe, expect, test } from "bun:test"
import { ReviewContext } from "../src/context.ts"
import { DEEP_CANDIDATES } from "../src/deep.ts"
import {
  assess,
  type Candidate,
  candidateSchema,
  changeExcerpt,
  dedupe,
  deepAssessmentLimits,
  reviewerSchema,
  validateReview,
  verifierSchema,
  verifierSchemaFor,
} from "../src/findings.ts"
import { bundle, cleanup, file, temporary } from "./review-fixture.ts"

afterEach(cleanup)
function fixture() {
  const root = temporary()
  file(root, "src/file.ts")
  const selected = bundle(root)
  return { root, selected, context: new ReviewContext(selected) }
}
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    path: "src/file.ts",
    side: "new",
    startLine: 2,
    endLine: 2,
    severity: "P2",
    category: "correctness",
    summary: "Changed value breaks the caller",
    scenario:
      "When the caller supplies an empty value, the new branch throws rather than returning a result.",
    evidence: [
      { path: "src/file.ts", side: "new", line: 2, reason: "The changed line is reached for empty values." },
    ],
    suggestedFix: "Retain the existing empty-value guard.",
    ...overrides,
  }
}
const reply = (...findings: unknown[]) => ({ findings, limitations: [] })
const finding = () => dedupe([{ candidate: candidate(), lens: "correctness" }])[0]!

describe("bounded structured findings", () => {
  test("exports strict schemas with required fields and no additional properties", () => {
    for (const schema of [candidateSchema, reviewerSchema, verifierSchema]) {
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required).toBeArray()
    }
  })
  test("accepts zero findings without fabricating success limitations", async () => {
    const { selected, context } = fixture()
    expect(await validateReview(reply(), selected, context)).toEqual({
      findings: [],
      limitations: [],
      complete: true,
    })
  })
  test("accepts a real changed line with source evidence and preserves old-side deletion anchors", async () => {
    const { selected, context } = fixture()
    expect((await validateReview(reply(candidate()), selected, context)).findings).toHaveLength(1)
    const deleted = candidate({
      side: "old",
      evidence: [
        { path: "src/file.ts", side: "old", line: 2, reason: "The removed guard handles this case." },
      ],
    })
    selected.changes[0]!.status = "D"
    selected.changes[0]!.patch = "--- a/src/file.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-old\n-three\n"
    selected.changes[0]!.hunks = [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }]
    const result = await validateReview(reply(deleted), selected, context)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.side).toBe("old")
    expect(changeExcerpt(selected, result.findings[0]!)).toContain("2: old")
    expect(changeExcerpt(selected, result.findings[0]!)).not.toContain("two")
    expect((await validateReview(reply(candidate()), selected, context)).findings).toHaveLength(0)
  })
  test("rejects fabricated coordinates, unchanged-context anchors and invalid ranges", async () => {
    const { selected, context } = fixture()
    for (const invalid of [
      candidate({ startLine: 999, endLine: 999 }),
      candidate({ startLine: 0, endLine: 0 }),
      candidate({ startLine: 1, endLine: 1 }),
      candidate({ startLine: 2.5 }),
      candidate({ endLine: 1 }),
      candidate({ endLine: 12 }),
      candidate({ path: "not-changed.ts" }),
      candidate({ path: "../src/file.ts" }),
      candidate({ evidence: [{ path: "src/file.ts", side: "new", line: 999, reason: "fabricated" }] }),
      candidate({ evidence: [{ path: "src/file.ts", side: "old", line: 999, reason: "fabricated" }] }),
      candidate({ evidence: [{ path: ".env", side: "new", line: 1, reason: "forbidden" }] }),
      candidate({ evidence: [{ path: "untracked.ts", side: "new", line: 1, reason: "unknown source" }] }),
    ]) {
      const result = await validateReview(reply(invalid), selected, context)
      expect(result.findings).toHaveLength(0)
      expect(result.limitations.length).toBeGreaterThan(0)
    }
  })
  test("accepts evidence from approved tracked context, but no unsupported old-side reconstruction", async () => {
    const { root, selected } = fixture()
    file(root, "caller.ts", "invoke()\n")
    selected.inventory.push("caller.ts")
    const context = new ReviewContext(selected)
    const entry = candidate({
      evidence: [
        { path: "caller.ts", side: "new", line: 1, reason: "The actual caller supplies empty input." },
      ],
    })
    expect((await validateReview(reply(entry), selected, context)).findings).toHaveLength(1)
    entry.evidence[0]!.side = "old"
    expect((await validateReview(reply(entry), selected, context)).findings).toHaveLength(0)
  })
  test("rejects metadata-only and excluded paths on old and new sides", async () => {
    const { selected, context } = fixture()
    selected.changes[0]!.metadataOnly = true
    expect((await validateReview(reply(candidate()), selected, context)).findings).toHaveLength(0)
    selected.changes[0]!.metadataOnly = false
    selected.excluded.push({ path: "src/file.ts", reason: "excluded fixture" })
    for (const side of ["old", "new"] as const)
      expect((await validateReview(reply(candidate({ side })), selected, context)).findings).toHaveLength(0)
  })
  test("rejects a changed file when either old or new path is excluded", async () => {
    const { selected, context } = fixture()
    selected.changes[0]!.oldPath = ".env"
    expect((await validateReview(reply(candidate()), selected, context)).findings).toHaveLength(0)
    selected.changes[0]!.oldPath = "src/file.ts"
    selected.changes[0]!.path = "vendor/file.ts"
    const old = candidate({
      side: "old",
      evidence: [{ path: "src/file.ts", side: "old", line: 2, reason: "Removed line" }],
    })
    expect((await validateReview(reply(old), selected, context)).findings).toHaveLength(0)
  })
  test("requires bounded fields, evidence, exact keys and a total 32 KiB cap", async () => {
    const { selected, context } = fixture()
    const invalid = [
      undefined,
      "```json\n{}\n```",
      { findings: [], limitations: [], extra: true },
      reply(candidate({ summary: "x".repeat(161) })),
      reply(candidate({ scenario: "x".repeat(1201) })),
      reply(candidate({ evidence: [] })),
      reply({ ...candidate(), extra: true }),
      reply({ ...candidate(), severity: "P0" }),
      reply({ ...candidate(), side: "both" }),
      reply(...Array.from({ length: 7 }, () => candidate())),
      { findings: [], limitations: ["x".repeat(33 * 1024)] },
      reply(candidate({ evidence: Array.from({ length: 4 }, () => candidate().evidence[0]!) })),
    ]
    for (const value of invalid) {
      const result = await validateReview(value, selected, context)
      expect(result.findings).toHaveLength(0)
      expect(result.limitations.length).toBeGreaterThan(0)
    }
    const cycle: Record<string, unknown> = {}
    cycle.value = cycle
    expect((await validateReview(cycle, selected, context)).findings).toHaveLength(0)
  })
  test("refuses shape-valid reviewer results exceeding the total 32 KiB limit", async () => {
    const { selected, context } = fixture()
    const large = candidate({
      summary: "s".repeat(160),
      scenario: "s".repeat(1200),
      suggestedFix: "f".repeat(1200),
      rule: "r".repeat(1200),
      evidence: Array.from({ length: 3 }, () => ({
        path: "src/file.ts",
        side: "new",
        line: 2,
        reason: "e".repeat(600),
      })),
    })
    const value = reply(...Array.from({ length: 6 }, () => large))
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(32 * 1024)
    const result = await validateReview(value, selected, context)
    expect(result.findings).toHaveLength(0)
    expect(result.limitations.join(" ")).toContain("32 KiB")
  })
  test("standards findings cite an applicable admitted rule, not an invented filename", async () => {
    const { root, selected } = fixture()
    file(root, "AGENTS.md", "Preserve the public empty-input return contract.\n")
    selected.inventory.push("AGENTS.md")
    const context = new ReviewContext(selected)
    const standards = candidate({
      category: "standards",
      rule: "AGENTS.md:1 requires preserving the public empty-input return contract.",
    })
    expect((await validateReview(reply(standards), selected, context)).findings).toHaveLength(1)
    standards.rule = "STYLE.md says this is bad"
    expect((await validateReview(reply(standards), selected, context)).findings).toHaveLength(0)
    standards.rule = "AGENTS.md:999 made-up rule coordinate"
    expect((await validateReview(reply(standards), selected, context)).findings).toHaveLength(0)
    standards.rule = "FAKEAGENTS.md:1 misleading filename suffix"
    expect((await validateReview(reply(standards), selected, context)).findings).toHaveLength(0)
  })
  test("sanitizes every model prose field and limitations", async () => {
    const { selected, context } = fixture()
    const secret = `ghp_${"a".repeat(36)}`
    const prose = `bad ${secret} \u001b[31mtext\u001b[0m`
    const unsafe = candidate({
      summary: prose,
      scenario: prose,
      suggestedFix: prose,
      rule: prose,
      evidence: [{ ...candidate().evidence[0]!, reason: prose }],
    })
    const result = await validateReview({ findings: [unsafe], limitations: [prose] }, selected, context)
    expect(result.findings).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("\\u001b")
  })
})

describe("conservative deterministic duplicates", () => {
  test("merges equivalent facts and retains source lenses with stable host IDs", () => {
    const first = candidate()
    const duplicate = candidate({ summary: ` ${first.summary} ` })
    const found = dedupe([
      { candidate: first, lens: "correctness" },
      { candidate: duplicate, lens: "contracts" },
      { candidate: first, lens: "correctness" },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: "F001",
      sources: ["correctness", "contracts"],
      assessment: "unchecked",
      ignored: false,
    })
  })
  test("does not merge distinct defects or distinct trigger scenarios on one line", () => {
    const findings = dedupe([
      { candidate: candidate(), lens: "correctness" },
      { candidate: candidate({ summary: "Concurrent callers lose writes" }), lens: "correctness" },
      {
        candidate: candidate({ scenario: "Only when the input is null, a different failure occurs." }),
        lens: "contracts",
      },
    ])
    expect(findings.map((entry) => entry.id)).toEqual(["F001", "F002", "F003"])
  })
})

describe("independent static assessments", () => {
  test("keeps supported, uncertain, refuted and missing/unchecked separate", () => {
    const findings = Array.from({ length: 4 }, (_, i) => ({ ...finding(), id: `F00${i + 1}` }))
    const limitations = assess(findings, {
      assessments: [
        { id: "F001", assessment: "supported", rationale: "Actual caller reaches the changed line." },
        { id: "F002", assessment: "uncertain", rationale: "Input assumptions remain unresolved." },
        { id: "F003", assessment: "refuted", rationale: "An existing guard prevents this path." },
      ],
      limitations: [],
    })
    expect(findings.map((entry) => entry.assessment)).toEqual([
      "supported",
      "uncertain",
      "refuted",
      "unchecked",
    ])
    expect(limitations.join(" ")).toContain("F004")
    assess(findings, undefined)
    expect(findings.every((entry) => entry.assessment === "unchecked" && entry.rationale === undefined)).toBe(
      true,
    )
  })
  test("duplicate, unknown, malformed and missing verifier IDs never silently gain support", () => {
    const findings = [finding(), { ...finding(), id: "F002" }]
    const result = assess(findings, {
      assessments: [
        { id: "F001", assessment: "supported", rationale: "One" },
        { id: "F001", assessment: "refuted", rationale: "Two" },
        { id: "F999", assessment: "supported", rationale: "Unknown" },
        { id: "F002", assessment: "supported", rationale: "Bad duplicate target", duplicateOf: "F999" },
      ],
      limitations: [],
    })
    expect(findings.every((entry) => entry.assessment === "unchecked")).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    expect(assess(findings, undefined)).toHaveLength(1)
  })
  test("accepts valid duplicates and refuses self-links and cycles", () => {
    const findings = [finding(), { ...finding(), id: "F002" }]
    assess(findings, {
      assessments: [
        { id: "F001", assessment: "supported", rationale: "Same defect as F002", duplicateOf: "F002" },
        { id: "F002", assessment: "supported", rationale: "Evidence supports it." },
      ],
      limitations: [],
    })
    expect(findings[0]!.duplicateOf).toBe("F002")
    const cycle = [finding(), { ...finding(), id: "F002" }]
    expect(
      assess(cycle, {
        assessments: [
          { id: "F001", assessment: "supported", rationale: "Same", duplicateOf: "F002" },
          { id: "F002", assessment: "supported", rationale: "Same", duplicateOf: "F001" },
        ],
        limitations: [],
      }).length,
    ).toBeGreaterThan(0)
    expect(cycle.every((entry) => entry.assessment === "unchecked")).toBe(true)
    expect(
      assess([finding()], {
        assessments: [{ id: "F001", assessment: "supported", rationale: "Same", duplicateOf: "F001" }],
        limitations: [],
      }).length,
    ).toBeGreaterThan(0)
  })
  test("sanitizes verifier rationale and limitations, and rejects oversized/extra fields", () => {
    const findings = [finding()]
    const secret = `ghp_${"b".repeat(36)}`
    const limits = assess(findings, {
      assessments: [{ id: "F001", assessment: "uncertain", rationale: secret }],
      limitations: [secret],
    })
    expect(JSON.stringify({ findings, limits })).not.toContain(secret)
    const untouched = [finding()]
    assess(untouched, { assessments: [], limitations: [], extra: true })
    expect(untouched[0]!.assessment).toBe("unchecked")
  })
})

test("one deep assessor batch covers more than twelve merged findings without changing normal limits", () => {
  const findings = Array.from({ length: DEEP_CANDIDATES }, (_, index) => ({
    ...finding(),
    id: `F${String(index + 1).padStart(3, "0")}`,
  }))
  const value = {
    assessments: findings.map((finding) => ({
      id: finding.id,
      assessment: "supported",
      rationale: "Static evidence supports it.",
    })),
    limitations: [],
  }
  expect(assess(findings, value)).toHaveLength(1)
  expect(findings.every((finding) => finding.assessment === "unchecked")).toBe(true)
  expect(assess(findings, value, DEEP_CANDIDATES)).toEqual([])
  expect(findings.every((finding) => finding.assessment === "supported")).toBe(true)
})

test("deep assessor schema and prompt allowances keep every admitted batch inside 32 KiB", () => {
  for (let count = 1; count <= DEEP_CANDIDATES; count++) {
    const limits = deepAssessmentLimits(count)
    const schema = JSON.parse(JSON.stringify(verifierSchemaFor(count, limits)))
    expect(schema.properties.assessments.maxItems).toBe(count)
    expect(schema.properties.assessments.items.properties.rationale.maxLength).toBe(limits.rationale)
    const value = {
      assessments: Array.from({ length: count }, (_, index) => ({
        id: `F${String(index + 1).padStart(3, "0")}`,
        assessment: "uncertain",
        rationale: "\u0001".repeat(limits.rationale),
        duplicateOf: "F001",
      })),
      limitations: Array.from({ length: limits.limitations }, () => "\u0001".repeat(limits.limitation)),
    }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(32 * 1024)
  }
  expect(deepAssessmentLimits(30).rationale).toBeLessThan(1100)
})
