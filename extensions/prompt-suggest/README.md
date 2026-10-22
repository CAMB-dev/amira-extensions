# prompt-suggest

Experimental next-message predictions for Amira 0.1.67 or later. After a successful main-session turn, this extension predicts one short message you might type next and shows it as gray ghost text in the empty prompt.

Press **Tab** to insert the suggestion without sending it. You can edit it before pressing Enter. Typing something else dismisses it; completion popups still take priority over suggestions.

Predictions run only in a local interactive TUI with an empty, idle prompt and no pending messages, approvals, dialogs or forms. There is at most one prediction request per turn. Failed, interrupted and budget-stopped turns are skipped. Editing the prompt (even typing then deleting), starting another turn, switching sessions, detaching the frontend or unloading the extension cancels pending predictions and prevents stale results from appearing.

## Install

```sh
amira ext install prompt-suggest
```

Run `/reload` after installing. Predictions are enabled by default once installed.

## Settings

Open this extension's settings through `/ext`, or add its section to your Amira settings:

```json
{
  "extensions": {
    "prompt-suggest": {
      "enabled": true,
      "model": ""
    }
  }
}
```

- **enabled** (default `true`): predict your next message after successful turns. Set to `false` to stop prediction requests and clear any suggestion.
- **model** (default empty): an optional `provider/model` reference. Empty uses the current session model, unchanged system prompt and conversation history, with the prediction instruction appended. Session tool definitions are retained where the provider supports it, but tool calls are forbidden. This preserves the prompt-cache prefix where supported; cache hits are not guaranteed. A configured model instead receives only bounded text excerpts of up to six recent user/assistant messages (at most 6,000 characters), without tools, images or reasoning blocks.

Changes apply immediately and cancel any current prediction. Invalid settings use their declared defaults. A model reference must include a provider and model with no whitespace; its provider must already be configured in Amira.

## Cost and privacy

**Predictions make paid model requests**, even if you ignore them or they return nothing. Usage is accounted by Amira in the current session, visible in `/cost` under `prompt-suggest`, and subject to the session's budget. Requests cancelled after starting may still incur usage. The extension requests a small output, but reasoning models can use additional tokens. Use a cheaper configured model or disable predictions to control cost.

The prediction request **sends conversation context to the configured model's provider**. With no model override, that is the session model and full current context, including any files, tool results or attachments already in it. With an override, recent user/assistant text excerpts are sent to that model's provider instead. Suggestions and counters are not stored by this extension; Amira's normal usage accounting still applies.

## Development

From this folder:

```sh
bun install --offline
bun run link-amira D:/dev/Amira
bun run typecheck
bun run lint
bun test
```

Tests mock the host, suggestion slots and model requests; they do not use the network or your Amira home directory.
