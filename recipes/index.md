# Superlog instrumentation recipes — index

This is the routing table. Detect the project's runtime + framework, then load the matching recipe file from this directory.

## Detection signals

Inspect the project root in this order. First match wins.

1. **AppleScript project** — any `.applescript`, `.scpt`, or `.scptd` file under the project root, and no `package.json` / `pyproject.toml` / `go.mod` at the root.
   → `applescript.md`

2. **Monorepo** — `pnpm-workspace.yaml` exists, OR `package.json` has a `"workspaces"` field. Don't load a base recipe; instead enumerate each workspace package, run detection per package, and dispatch one subagent per package with the matching recipe + any integrations from step 6.

3. **Next.js** — `package.json` has `next` in `dependencies` or `devDependencies`.
   → `node/next.md`

4. **Vite / browser** — `package.json` has `vite` in `dependencies` or `devDependencies` AND no server-side framework marker (Hono, Express, Fastify, NestJS, Next).
   → `node/vite.md`

5. **Node server** — `package.json` exists and none of the above matched. Covers Hono, Express, Fastify, NestJS, plain Node.
   → `node/server.md`

6. **FastAPI** — `pyproject.toml` or `requirements.txt` lists `fastapi`.
   → `python/fastapi.md`

7. **Fallback** — anything else, including unknown Python stacks, Go, Rust, etc.
   → `generic.md`

## Sub-framework integrations

Apply these on top of the base recipe (do NOT replace the base bootstrap). Detect by scanning the package's `dependencies` + `devDependencies` (or pyproject equivalent).

| Marker | Recipe |
|---|---|
| `@temporalio/worker` | `integrations/temporal-worker.md` |
| `@temporalio/client` (without `@temporalio/worker` in the same package) | `integrations/temporal-client.md` |
| `@livekit/agents` or `livekit-agents` (Python) | `integrations/livekit-agents.md` |
| `livekit-server-sdk` | `integrations/livekit-server.md` |
| `livekit-client` | `integrations/livekit-client.md` |

Multiple integrations can apply to the same package. Layer each on top of the base, in the order listed.

## What every recipe assumes

- An OTLP endpoint URL and an ingest API key are available to inject into env files. The recipe never embeds the literal key in source code — always via env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <key>`).
- The agent has permission to install packages, write files inside the project root, and run the project's own dev/build/start commands.
- Verification means: (a) the project's own dev/build command starts cleanly with the instrumentation in place, AND (b) a small OTLP test span POSTed to `<endpoint>/v1/traces` returns 2xx.
