import { expect, test } from "bun:test"
import type { ViewControl } from "@amira/api"
import type { SwarmSnapshot } from "../src/swarm.ts"
import { type SwarmViewData, swarmView } from "../src/view.ts"

/** A running swarm's view data whose control counts the stops. */
function running() {
  let stops = 0
  const data: SwarmViewData = {
    snapshot: () => ({ state: "running", members: [] }) as unknown as SwarmSnapshot,
    control: {
      tell: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      stopMember: () => undefined,
      stop: () => {
        stops++
      },
    },
  }
  return { data, stops: () => stops }
}

function control(answer: boolean, asked: string[]): ViewControl {
  return {
    close: () => {},
    pushPage: () => {},
    popPage: () => {},
    requestRender: () => {},
    print: () => {},
    prompt: async () => undefined,
    confirm: async (q, o) => {
      asked.push(`${q} y ${o?.yes} · any other key ${o?.no}`)
      return answer
    },
  }
}

test("s asks before it stops the whole swarm, the way the frontend's views ask", async () => {
  const s = swarmView.keys!.find((k) => k.key === "s")!
  const asked: string[] = []
  const no = running()
  s.run!(no.data, control(false, asked))
  await Bun.sleep(5)
  expect(asked).toEqual(["Stop the whole swarm? y stops it · any other key keeps it running"])
  expect(no.stops()).toBe(0)
  expect(no.data.flash).toBe("Not stopped.")
  const yes = running()
  s.run!(yes.data, control(true, asked))
  await Bun.sleep(5)
  expect(yes.stops()).toBe(1)
  expect(yes.data.flash).toBe("Stopping the swarm.")
})

test("without confirm (an older frontend) it asks for yes to be typed", async () => {
  const s = swarmView.keys!.find((k) => k.key === "s")!
  const r = running()
  const titles: string[] = []
  s.run!(r.data, {
    close: () => {},
    pushPage: () => {},
    popPage: () => {},
    requestRender: () => {},
    print: () => {},
    prompt: async (title: string) => {
      titles.push(title)
      return "yes"
    },
  } as unknown as ViewControl)
  await Bun.sleep(5)
  expect(titles).toEqual(['Stop the whole swarm? Type "yes" to stop it:'])
  expect(r.stops()).toBe(1)
})
