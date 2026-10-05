import type { Extension } from "@amira/api"

/** Observe the real assembled prompt through public APIs only; never write to disk. */
const observe: Extension = (api) => {
  let memory = ""
  const captures: Array<{ memory: string; systemPrompt: string }> = []
  api.intercept(
    "system.build",
    ({ sections }) => {
      memory = sections.find((section) => section.name === "memory")?.text ?? ""
      return { action: "pass" }
    },
    { priority: 100 },
  )
  api.intercept("context.build", ({ systemPrompt }) => {
    captures.push({ memory, systemPrompt })
    return { action: "pass" }
  })
  api.registerCommand({
    name: "memory-captures",
    description: "Read offline test prompt captures",
    run(_args, ctx) {
      ctx.print(JSON.stringify(captures))
    },
  })
}

export default observe
