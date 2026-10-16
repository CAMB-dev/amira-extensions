import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI, OwnedConversation } from "@amira/api"
import { latestPrototypeManifest, Prototypes } from "../src/prototype.ts"
import { createProject, IterationStore } from "../src/store.ts"
import { human } from "./iteration-binding-helper.ts"

setDefaultTimeout(60_000)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

for (const malformed of [
  "trailing cwd separator",
  "duplicate prerequisites",
  "file cwd",
  "in-variant cwd link",
] as const) {
  test(`a report with ${malformed} becomes failed instead of permanently blocking refresh`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-prototype-report-"))
    roots.push(root)
    const project = await createProject(root, "Report regression")
    const store = new IterationStore(project)
    const summary = await store.saveArtifact(0, {
      kind: "stage-summary",
      stage: "design",
      language: "en",
      summary: "Skip design",
      outputs: [],
      suggestion: "Prepare prototypes",
    })
    let state = await store.dispatch(summary.state.revision, {
      type: "prepare-summary",
      expectedRevision: summary.state.revision,
      artifact: summary.artifact,
    })
    state = await store.dispatch(state.revision, {
      type: "propose-transition",
      expectedRevision: state.revision,
      proposal: {
        id: "skip-design",
        from: "design",
        to: "prototype",
        kind: "skip",
        summaryId: state.summaryId!,
        skippedStages: ["design"],
        suggestion: "Prepare prototypes",
      },
    })
    state = await store.dispatch(state.revision, {
      type: "confirm-transition",
      expectedRevision: state.revision,
      receipt: human(state, "skip-design", "prototype"),
    })
    const directory = await store.preparePrototypeDirectory("alpha")
    const file = path.join(directory, "main.ts")
    const link = path.join(directory, "current")
    if (malformed === "in-variant cwd link") {
      const target = path.join(directory, "app")
      await mkdir(target)
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
    }
    await writeFile(file, "console.log('local prototype')\n")
    await store.saveArtifact(state.revision, {
      kind: "prototype-manifest",
      variants: [
        {
          id: "alpha",
          idea: "Local fixture",
          question: "Does the interaction work?",
          directory,
          cwd: directory,
          runCommand: null,
          prerequisites: [],
          notes: "",
          status: "building",
        },
      ],
    })
    const report = {
      runCommand: "bun main.ts",
      cwd:
        malformed === "trailing cwd separator"
          ? `${directory}${path.sep}`
          : malformed === "file cwd"
            ? file
            : malformed === "in-variant cwd link"
              ? link
              : directory,
      prerequisites: malformed === "duplicate prerequisites" ? ["Bun", "Bun"] : [],
      notes: "A small local fixture",
    }
    const controller = new Prototypes({ apiVersion: "0.1.53", conversations: {} } as ExtensionAPI)
    const handle = {
      status: () => ({ state: "idle", busy: false }),
      history: () => [
        {
          role: "assistant",
          content: [{ type: "text", text: `\`\`\`prototype-report\n${JSON.stringify(report)}\n\`\`\`` }],
        },
      ],
    } as unknown as OwnedConversation
    const inspect = spyOn(controller.sessions, "inspect").mockResolvedValue(handle)
    try {
      const first = await controller.refresh(project, {} as Parameters<Prototypes["refresh"]>[1], "en")
      expect(first?.variants[0]).toMatchObject({ status: "failed", runCommand: null, cwd: directory })
      expect(first?.variants[0]?.notes).toContain("Invalid prototype report")
      const revision = (await store.read()).revision
      expect(await controller.refresh(project, {} as Parameters<Prototypes["refresh"]>[1], "en")).toEqual(
        first,
      )
      expect((await store.read()).revision).toBe(revision)
      expect((await latestPrototypeManifest(store))?.manifest).toEqual(first)
      if (malformed === "in-variant cwd link") {
        const opening = spyOn(controller.sessions, "open").mockResolvedValue(handle)
        try {
          await controller.run(
            ["alpha"],
            project,
            {
              signal: new AbortController().signal,
              session: { info: () => ({ id: "main" }) },
              focusConversation: () => true,
              print: () => {},
            } as unknown as Parameters<Prototypes["run"]>[2],
            "en",
            () => {},
            () => {},
            async () => {},
          )
          expect(opening).toHaveBeenCalledTimes(1)
          expect((await store.read()).phase).toBe("running")
          expect((await latestPrototypeManifest(store))?.manifest.variants[0]?.status).toBe("building")
        } finally {
          opening.mockRestore()
        }
      }
    } finally {
      inspect.mockRestore()
    }
  })
}
