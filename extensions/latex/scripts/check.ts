import { realpathSync } from "node:fs"
import path from "node:path"

// Use the already-installed tools in the checkout selected by link-amira.
const repo = path.resolve(realpathSync(new URL("../node_modules/@amira/api", import.meta.url)), "../..")
const check = process.argv[2]
const args =
  check === "typecheck"
    ? [
        path.join(repo, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "-p",
        "tsconfig.json",
        "--typeRoots",
        path.join(repo, "node_modules/@types"),
      ]
    : check === "lint"
      ? [
          path.join(repo, "node_modules/@biomejs/biome/bin/biome"),
          "check",
          `--config-path=${repo}`,
          "src",
          "test",
          "scripts",
          "package.json",
          "tsconfig.json",
        ]
      : undefined
if (!args) throw new Error("usage: bun scripts/check.ts <typecheck|lint>")
const child = Bun.spawnSync([process.execPath, ...args], {
  cwd: path.resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(child.exitCode)
