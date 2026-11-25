# goal

Goal-driven completion loop for [Amira](https://github.com/CAMB-dev/Amira): keep the agent pushing until explicit acceptance criteria and verification checks pass, instead of stopping early.

```sh
amira ext install goal
```

Requires Amira extension API `^0.1.72` (`turn.beforeEnd`, `api.openView`, `OwnedConversation.ephemeral`, `session.usage()`).

## Usage

```text
/goal "<objective>" [--verify "<cmd>"] [--mode session|fresh] [--judge none|llm|verifier] [--max N] [--budget USD]
/goal                  Open the Goal dock
/goal status           Show current goal criteria & verification logs
/goal pause | resume   Pause or resume the active goal
/goal stop [reason]    Stop the active goal
/goal edit add <text>  Add a criterion
/goal edit rm <id|#>   Remove a criterion
```

## Highlights

- **Zero-friction start + optional criteria breakdown**: starts immediately when `--verify` or `--now` is given; for open-ended objectives in the TUI, proposes a 3–5 item acceptance checklist with suggested verification commands for one-click confirmation.
- **Dual execution modes**:
  - `session` (default): stays in the main session (hits prompt cache, supports mid-turn steering) and gates stops via `turn.beforeEnd`.
  - `fresh`: runs each iteration in a clean ephemeral `OwnedConversation` (Ralph-loop style) backed by persisted state so long runs avoid context rot.
- **Composable verification pipeline**: `goal_complete` tool → deterministic `--verify` shell commands → optional `--judge llm` (`api.complete`) or `--judge verifier` (independent read-only subagent with schema).
- **Guardrails**: never overrides user `Esc` interrupt (pauses cleanly), enforces max iterations & USD budget cap, detects stuck loops (3 identical failures without progress → 1 strategy-shift reflection prompt, then pauses for human help), and works seamlessly with `pair` (`pair_ask`) when teammates are connected.
- **Composable service contract**: provides `goal.run`, `goal.status`, and `goal.stop` via `api.provideService` for `project` or other orchestrators.
