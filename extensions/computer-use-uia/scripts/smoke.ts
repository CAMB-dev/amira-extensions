/** Explicit fixture-only desktop run. Never run while someone is using the machine. */
if (process.env.AMIRA_UIA_DESKTOP_TESTS !== "1") {
  throw new Error("Desktop smoke is opt-in: set AMIRA_UIA_DESKTOP_TESTS=1 on an idle test machine")
}
const child = Bun.spawn(["bun", "test", "./test/desktop.test.ts"], {
  cwd: `${import.meta.dir}/..`,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
process.exitCode = await child.exited
