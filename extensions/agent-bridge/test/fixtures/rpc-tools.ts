import { defineExtension, defineTool, textResult } from "@amira/api"

/** Same offline tools as the linked CLI's RPC test; no private core imports. */
export default defineExtension((api) => {
  api.registerTool(
    defineTool<{ ms: number }>({
      name: "wait",
      description: "Waits",
      parameters: { type: "object", properties: { ms: { type: "number" } } },
      execute: async (params) => {
        await Bun.sleep(params.ms)
        return textResult("waited")
      },
    }),
  )
  api.registerTool(
    defineTool({
      name: "ask",
      description: "Asks",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const answer = await api.ui.confirm("Deploy?", "to production")
        return textResult(`answer: ${answer ?? "nobody answered"}`)
      },
    }),
  )
})
