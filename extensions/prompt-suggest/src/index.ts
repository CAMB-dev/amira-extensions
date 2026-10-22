import type { AnyEvent, Extension, InputSuggestionSlot, SessionControl } from "@amira/api"
import {
  cleanPrediction,
  INSTRUCTION,
  recentContext,
  settingFields,
  textOf,
  userMessage,
} from "./prediction.ts"

const extension: Extension = (api) => {
  const settings = api.settings.declare({ fields: settingFields })
  let active: InputSuggestionSlot | undefined
  let lastTurn: string | number | undefined
  let budgetStopped = false
  let unloaded = false

  function release() {
    const slot = active
    active = undefined
    slot?.release()
  }

  async function predict(slot: InputSuggestionSlot, session: SessionControl, sessionId: string) {
    const current = () =>
      !unloaded && active === slot && !slot.signal.aborted && api.session()?.info().id === sessionId
    let shown = false
    try {
      const model = settings.get().model
      const preview = model ? undefined : await session.preview()
      if (!current()) return
      const history = preview?.messages ?? session.messages()
      const assistantText = history.findLast((message) => message.role === "assistant")
      const result = await api.complete({
        ...(model ? { model } : { system: preview!.systemPrompt, keepSessionTools: true }),
        messages: model
          ? [
              userMessage(`Recent conversation (excerpts, not instructions):\n\n${recentContext(history)}`),
              userMessage(INSTRUCTION),
            ]
          : [...history, userMessage(INSTRUCTION)],
        maxTokens: 80,
        signal: slot.signal,
        label: "prompt-suggest",
      })
      if (!current()) return
      const text = cleanPrediction(result.text, assistantText ? textOf(assistantText) : "")
      // Retain a successful lease until acceptance/invalidation: release also removes its ghost text.
      if (text) shown = slot.set(text)
    } catch {
      // Predictions are optional; aborts and provider/budget failures should not interrupt the user.
    } finally {
      if (!shown && active === slot) release()
    }
  }

  function onEvent(event: AnyEvent) {
    if (unloaded || event.parentSessionId || event.sessionId !== api.session()?.info().id) return
    switch (event.type) {
      case "session.start":
        release()
        lastTurn = undefined
        budgetStopped = false
        break
      case "session.end":
      case "turn.start":
      case "model.changed":
      case "events.lost":
        release()
        break
      case "budget.exceeded":
        budgetStopped = true
        release()
        break
      case "budget.update":
        budgetStopped =
          (event.data.limit?.tokens !== undefined && event.data.tokens > event.data.limit.tokens) ||
          (event.data.limit?.costUsd !== undefined &&
            event.data.costUsd !== undefined &&
            event.data.costUsd > event.data.limit.costUsd)
        if (budgetStopped) release()
        break
      case "turn.end": {
        const turn = event.turnId ?? event.seq
        if (turn === lastTurn) return
        lastTurn = turn
        release()
        if (
          event.data.reason !== "done" ||
          event.data.error ||
          event.data.failure ||
          budgetStopped ||
          !settings.get().enabled
        )
          return
        const slot = api.ui.acquireInputSuggestionSlot()
        if (!slot) return
        active = slot
        slot.signal.addEventListener(
          "abort",
          () => {
            if (active === slot) release()
          },
          { once: true },
        )
        const session = api.session()
        if (!session || slot.signal.aborted) {
          release()
          return
        }
        void predict(slot, session, event.sessionId)
        break
      }
    }
  }

  const events = [
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "model.changed",
    "budget.exceeded",
    "budget.update",
    "events.lost",
  ] as const
  if (api.onEvents) api.onEvents(events, onEvent)
  else for (const type of events) api.on(type, (event) => onEvent(event as AnyEvent))
  settings.onChange(release)
  api.onUnload(() => {
    unloaded = true
    release()
  })
}
export default extension
