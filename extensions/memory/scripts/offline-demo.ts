import { offlineDemo } from "./offline.ts"

await offlineDemo(process.argv[2] ?? process.env.AMIRA_TEST_CORE ?? "D:/dev/Amira", console.log)
console.log("Offline memory demo completed; temporary home and cwd removed.")
