# Contributing

## What's accepted

- New channel types (Telegram, Discord, Slack, etc. patterns) — first-class TypeScript modules in `src/channels/`. See [docs/ADDING_A_CHANNEL.md](docs/ADDING_A_CHANNEL.md) for the `Channel` interface contract and the plumbing required to make the new type installable via the admin shell.
- Bug fixes, security fixes, simplifications, reducing code.
- Capability pods (MCP servers, model-server adapters) — wire via Helm `capabilities:` / `mcpServers:` and document in [docs/INSTALLING_A_CHANNEL.md](docs/INSTALLING_A_CHANNEL.md).
- Inline preprocessing modules (image-vision, pdf-reader, voice-transcription) — `src/preprocessing/*.ts`, plumbed into the orchestrator's preprocessing job.

## How to contribute a new channel type

1. Implement the `Channel` interface from `src/types.ts` in `src/channels/<name>.ts` — see existing channels (`telegram.ts`, `slack.ts`, `discord.ts`) for reference.
2. Self-register at module bottom; add a barrel import to `src/channels/index.ts`.
3. Plumb the new type into `src/skills/orchestrator/channel-setup.ts` and the validated enum in `src/skills/orchestrator/types.ts` so the admin shell `setup_channel` tool can install it.
4. Write a unit test at `src/channels/<name>.test.ts` and an integration test if external behavior matters.
5. Add a runtime spec at `skills/channel/<name>.md` describing dependencies and required env vars.
6. Open a PR.

## Testing

Run the full suite before submitting:

```bash
npm run typecheck
npm test
```

For changes touching K8s manifests or the orchestrator's pod-spec construction:

```bash
npm run test:e2e -- <relevant-test-file>
```
