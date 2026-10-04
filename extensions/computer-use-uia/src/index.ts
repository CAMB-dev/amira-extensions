import { defineExtension } from "@amira/api"
import { setup } from "./extension.ts"

export default defineExtension((api) => {
  setup(api)
})
