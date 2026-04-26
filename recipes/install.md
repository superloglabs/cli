# Superlog install — agent bootstrap

You're an AI coding agent (Claude Code, Cursor, Aider, OpenAI Codex CLI, your own — doesn't matter). The user pointed you at this file to instrument their project so OpenTelemetry traces, logs, and metrics flow to Superlog. Follow these steps in order. Don't skip the verification step.

## Step 0 — Prerequisites

Ask the user for two values. Don't proceed without both.

1. **Ingest API key.** Starts with `superlog_live_`. They get it from https://superlog.sh/keys — sign in, create a project, copy the key.
2. **OTLP endpoint.** Region-specific. Default: `https://ingest.eu.superlog.sh`. The dashboard shows the right one for their project.

The key is a write-only credential scoped to one project. Never embed it as a literal in source files — only in env files (`.env.local`, `.env.superlog`, etc.) read at runtime via `process.env` / `os.getenv` / equivalent.

## Step 1 — Detect the project

From the project root (`cwd`), check signals in this priority order. First match wins.

1. Any `.applescript`, `.scpt`, or `.scptd` under the root, and no `package.json` / `pyproject.toml` / `go.mod` at the root → **AppleScript**.
2. `pnpm-workspace.yaml` exists, OR `package.json` has a `"workspaces"` field → **monorepo**. Don't load a base recipe — enumerate each workspace package, run detection per package, then apply Step 2 per package (one recipe per package, layered with any integrations from Step 1.5).
3. `package.json` lists `next` in `dependencies` or `devDependencies` → **Next.js**.
4. `package.json` lists `vite` AND no server framework marker (Hono/Express/Fastify/NestJS/Next) → **Vite (browser)**.
5. `package.json` exists, none of the above → **Node server** (Hono/Express/Fastify/NestJS/plain Node).
6. `pyproject.toml` or `requirements.txt` lists `fastapi` → **FastAPI**.
7. Anything else → **generic** (Go, unknown Python stacks, Rust, etc).

## Step 1.5 — Detect sub-framework integrations

Scan the package's deps + devDeps (or pyproject equivalent). Each match adds an integration layered on top of the base recipe.

| Marker | Integration |
|---|---|
| `@temporalio/worker` | `temporal-worker` |
| `@temporalio/client` (without `@temporalio/worker` in the same package) | `temporal-client` |
| `@livekit/agents` or `livekit-agents` (Python) | `livekit-agents` |
| `livekit-server-sdk` | `livekit-server` |
| `livekit-client` | `livekit-client` |

Multiple integrations can apply. Layer each on top of the base, in the order listed.

## Step 2 — Fetch and apply the recipe

Fetch the markdown file at the URL below for the base recipe, plus one per sub-framework. Read the recipe and follow its instructions exactly:

- Install the listed packages using the project's package manager (detect via lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, `poetry.lock` → poetry, `uv.lock` → uv).
- Create the bootstrap file at the path the recipe specifies.
- Write env vars to the env file the recipe specifies. The OTLP endpoint and ingest key from Step 0 go into the env vars listed in the recipe.

### Base recipes

| Detection | URL |
|---|---|
| AppleScript | https://skills.superlog.sh/applescript.md |
| Next.js | https://skills.superlog.sh/node/next.md |
| Vite / browser | https://skills.superlog.sh/node/vite.md |
| Node server | https://skills.superlog.sh/node/server.md |
| FastAPI | https://skills.superlog.sh/python/fastapi.md |
| Generic / unknown | https://skills.superlog.sh/generic.md |

### Integration recipes (layer on top of base)

| Integration | URL |
|---|---|
| `temporal-worker` | https://skills.superlog.sh/integrations/temporal-worker.md |
| `temporal-client` | https://skills.superlog.sh/integrations/temporal-client.md |
| `livekit-agents` | https://skills.superlog.sh/integrations/livekit-agents.md |
| `livekit-server` | https://skills.superlog.sh/integrations/livekit-server.md |
| `livekit-client` | https://skills.superlog.sh/integrations/livekit-client.md |

## Step 3 — Add custom spans

After the bootstrap is in place, identify 3–7 critical business operations in the codebase (entry routes, queue processors, integration calls, jobs) and wrap each with a manual span. Use `domain.verb` naming (`order.process`, `payment.charge`, `email.send`). Set entity IDs and counts as attributes. Record exceptions with `span.recordException` + `SpanStatusCode.ERROR`. Skip trivial helpers and anything already covered by auto-instrumentation.

For Temporal-worker-only packages, skip this step — the interceptor already covers workflow/activity spans.

## Step 4 — Verify

1. Run the project's own dev or build command (whatever package.json / pyproject scripts / Makefile is wired up to). Confirm it starts cleanly and no errors trace back to your OTel install. For a web framework, start the dev server, wait for it to report ready, hit one route with curl so traffic flows through your instrumentation, then kill the server.
2. POST a tiny OTLP test span to `<endpoint>/v1/traces` with `authorization: Bearer <key>`. 2xx confirms ingest is reachable.

## Step 5 — Report back to the user

In plain prose, tell the user:

- **Done / partial / failed.** Done = both checks in Step 4 passed. Partial = instrumentation loads but ingest unreachable (network/DNS issue). Failed = the project's dev/build now errors because of your changes, OR ingest returned 401/403/400, OR a package install failed.
- **What you changed.** Packages installed, files created, files modified, env vars written. 3–7 short factual bullets.
- **Where to look.** https://superlog.sh/dash for traces, after they trigger some traffic.
- **What they need to do for prod.** The ingest key is in `.env.local` / `.env.superlog`. They need to load it the same way in CI/prod (their secret manager, container env, etc.).

## Rules

- Never modify files outside the project root.
- Never commit, push, or open PRs.
- Never embed the ingest key as a literal in `.ts` / `.js` / `.py` / `.go` source.
- Use the project's existing package manager.
- Prefer idempotent edits — if a config file exists, edit rather than overwrite.
- If you can't complete Step 4 cleanly, report exactly what failed and stop. Don't guess.
