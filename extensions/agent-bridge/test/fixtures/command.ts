import { appendFileSync } from "node:fs"
import path from "node:path"
import type { PackageCommandContext } from "@amira/api"
import command from "../../src/command.ts"
import { BridgeDaemon } from "../../src/daemon.ts"
import { ownedPipe } from "../../src/owned-pipe.ts"
import { RpcClient } from "../../src/rpc.ts"
import { processIdentity, readState } from "../../src/storage.ts"

/** Real host/openPipe and detached bootstrap; only add the offline RPC fixture flags. */
export default async function fixtureCommand(ctx: PackageCommandContext): Promise<number> {
  if (ctx.argv[0] !== "__daemon") return command(ctx)
  if (process.env.AMIRA_BRIDGE_TEST_HOME !== ctx.home || !process.env.AMIRA_TEST_MOCK) {
    throw new Error("Integration daemon requires its isolated test home and offline model")
  }
  const record = async (pid: number, role: string) => {
    const identity = await processIdentity(pid, ctx.runCommand)
    appendFileSync(
      path.join(ctx.home, "owned-processes.jsonl"),
      `${JSON.stringify({ pid, role, identity })}\n`,
    )
  }
  const records: Promise<void>[] = [record(process.pid, "daemon")]
  const rpc = new RpcClient((argv, options) =>
    ownedPipe(argv, {
      ...options,
      onEvent: (event) => {
        if (event.type === "spawned") records.push(record(event.pid, "rpc"))
        options.onEvent(event)
      },
    }),
  )
  const daemon = new BridgeDaemon({
    home: ctx.home,
    state: readState(ctx.home, ctx.argv[1]!),
    amiraArgv: ctx.amiraArgv,
    rpc,
    probe: (pid) => processIdentity(pid, ctx.runCommand),
    rpcArgs: ["--no-builtins", "-e", path.join(import.meta.dir, "rpc-tools.ts")],
  })
  const stop = () => {
    void daemon.stop("test process signal")
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  try {
    await daemon.start()
    await daemon.done
    await Promise.all(records)
    return daemon.state.status === "failed" ? 1 : 0
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    await Promise.allSettled(records)
  }
}
