# pair

Decentralized end-to-end encrypted multi-peer collaboration and Agent-to-Agent (A2A) grilling & handoff for [Amira](https://github.com/CAMB-dev/Amira). Zero external npm dependencies.

Unlike centralized "many humans → one shared bot" tools, every teammate keeps their own **strictly isolated local Amira agent, workspace, credentials, and token budget**, communicating across the network only on demand.

```sh
amira ext install pair
```

Requires Amira extension API `^0.1.72` (`api.openView`, `OwnedConversation.ephemeral`, `session.forkMessages()`).

## Quick Start

```text
# Teammate A (e.g. PM who just brainstormed requirements in Amira)
/pair start --name alice --role pm --lan

# Teammate B (e.g. Dev on another machine)
/pair join ws://<host>:<port>#<code-from-alice> --name bob --role dev
```

Or connect across NAT via the included zero-knowledge WebSocket relay:

```sh
# Self-host relay on any server with Bun (or deploy relay/worker.ts to Cloudflare Durable Objects)
bun relay/server.ts --port 8787 --host 0.0.0.0

# Both peers connect with a short pairing code
/pair start --name alice --role pm --relay wss://relay.example.com
/pair join 42-amber-falcon --name bob --role dev --relay wss://relay.example.com
```

## Key Features

- **2–N Peer E2EE Rooms**: pairwise ephemeral `X25519` ECDH + persistent `Ed25519` identity signatures + directional `AES-256-GCM` with monotonic replay protection and a 4-word safety code. The relay sees only opaque ciphertext.
- **`btw`-Style Live Fork Context (Default)**: answers teammate agent questions directly from a read-only fork of your main session (`session.forkMessages()` + `api.complete({ keepSessionTools: true })`), hitting your prompt cache without polluting or locking your main session, with automatic outbound secret redaction. Use `--brief` for curated summaries, or `--scope read-context` for isolated ephemeral read-only workspace tools.
- **Non-Intrusive Decision Card Queue**: when a teammate's agent grills yours and hits an unsettled decision, your agent pushes `input-required` status to the caller and queues a **Decision Card** in your Pair Dock (no modal popup interrupting your typing). Answer in the Dock at your pace and your agent resumes seamlessly.
- **Dual-Signed Immutable Handoffs**: `pair_handoff` proposes versioned Markdown + YAML snapshots (`requirements`, `api-contract`, `design-notes`, `review`) with SHA-256 verification. Once accepted, both peers atomically save `.amira/handoffs/<id>-v<N>.md` and can inject it into their main session or import it into `project`.
- **Works with `goal`**: when `goal` and `pair` are both active, an autonomous `/goal` agent can call `pair_ask` mid-run to resolve requirement ambiguities with a connected teammate and keep pushing automatically.
