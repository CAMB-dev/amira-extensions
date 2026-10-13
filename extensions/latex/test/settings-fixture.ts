import type { Settings } from "@amira/api"
import { ExtensionSettingsRegistry } from "../node_modules/@amira/core/src/extension-settings.ts"

/** Uses the real host validator without any settings file reads, writes, or home discovery. */
export function settingsRegistry(settings: Settings = {}) {
  return new ExtensionSettingsRegistry({
    settings,
    settingsSources: { cwd: import.meta.dir, home: import.meta.dir },
    warning: () => {},
    failure: (_source, error) => {
      throw new Error(error)
    },
  })
}
