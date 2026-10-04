import { type ExtensionAPI, textResult, type ToolDefinition } from "@amira/api"
import { type TreeResult, UiaClient } from "./client.ts"
import { readSettings } from "./settings.ts"

let platformNoticeShown = false

export function setup(api: ExtensionAPI, platform = process.platform): UiaClient | undefined {
  if (platform !== "win32") {
    if (!platformNoticeShown) {
      platformNoticeShown = true
      api.notify("computer-use-uia: Windows only; no tools registered.")
    }
    return
  }
  let settings: ReturnType<typeof readSettings>
  try {
    settings = readSettings(api.settings.extensions?.["computer-use-uia"])
  } catch (error) {
    api.reportError(String(error))
    return
  }
  if (!settings.enabled) return
  const client = new UiaClient(api, settings.apps)
  for (const tool of tools(client)) api.registerTool(tool)
  api.on("session.end", (event) => {
    if (!event.parentSessionId) void client.stop().catch((error) => api.reportError(String(error)))
  })
  api.onExit(() => client.stop())
  return client
}

function tools(client: UiaClient): ToolDefinition<Record<string, unknown>>[] {
  const window = { type: "string", description: "Window handle returned by ui_launch, never another window" }
  const ref = { type: "string", description: "Element ref from this window's latest ui_tree" }
  const definitions = [
    {
      name: "launch",
      description: `Launch an allowed Windows app in a new process/window. Allowed names: ${Object.keys(client.apps).join(", ") || "(none)"}. Only these launched windows can be read or controlled.`,
      properties: { app: { type: "string", enum: Object.keys(client.apps) } },
      required: ["app"],
    },
    {
      name: "tree",
      description: "Read a launched window's UI Automation tree, with snapshot refs, values, flags and traversal timing. A new tree replaces the old refs. No screenshots.",
      properties: {
        window,
        depth: { type: "integer", minimum: 0, maximum: 30, default: 8 },
        maxNodes: { type: "integer", minimum: 1, maximum: 1000, default: 300 },
      },
      required: ["window"],
    },
    {
      name: "click",
      description: "Activate a snapshot element via its UIA pattern, or its on-screen clickable point. Reports the path used.",
      properties: { window, ref },
      required: ["window", "ref"],
    },
    {
      name: "type",
      description: "Set an element's value with ValuePattern, or focus it and send Unicode text. Without ref, type into the launched window's focused control. Reports the path used.",
      properties: { window, ref, text: { type: "string", maxLength: 20_000 } },
      required: ["window", "text"],
    },
    {
      name: "key",
      description: "Focus a launched window and send a single key or chord (ctrl+s, enter, shift+tab). alt+f4 and desktop-switching chords are refused; close with ui_close.",
      properties: { window, keys: { type: "string" } },
      required: ["window", "keys"],
    },
    {
      name: "close",
      description: "Close a launched window via WindowPattern.Close, then kill only its owned process by PID if it does not exit promptly. Unsaved changes may be discarded.",
      properties: { window },
      required: ["window"],
    },
  ]
  return definitions.map((definition) => ({
    name: `ui_${definition.name}`,
    description: definition.description,
    parameters: {
      type: "object",
      properties: definition.properties,
      required: definition.required,
      additionalProperties: false,
    },
    concurrency: "serial",
    mainOnly: true,
    ...(definition.name === "tree" ? { traits: { readOnly: true } } : {}),
    async execute(params, ctx) {
      if (ctx.signal.aborted) return textResult("UIA request cancelled", true)
      try {
        const result = await client.call(definition.name, params)
        if (definition.name === "tree") {
          const tree = result as TreeResult
          return textResult([
            tree.text,
            ...(tree.cut ? ["… tree cut at the node/character limit"] : []),
            `Traversal: ${tree.ms} ms; ${tree.nodes} nodes; ${tree.chars} characters.`,
          ].join("\n"))
        }
        return textResult(JSON.stringify(result))
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true)
      }
    },
  }))
}
