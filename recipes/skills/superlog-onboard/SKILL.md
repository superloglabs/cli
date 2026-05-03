---
name: superlog-onboard
description: Onboard a project to Superlog by installing OpenTelemetry traces, logs, and metrics across every app and service in the repo. Triggers on requests like "install Superlog", "set up Superlog", "add Superlog telemetry", "onboard this repo to Superlog", "instrument with OpenTelemetry for Superlog".
---

# Superlog onboarding

Wire OpenTelemetry traces, logs, and metrics into the user's project so telemetry streams to Superlog. Cover **every app and service in the repo** — not just the one the user is currently sitting in.

You don't need framework-specific recipes for this. Modern OTel SDKs are well-documented and the model can read the project, pick the right packages, and wire them up. If a specific stack stumps you, search the OTel docs for that language; don't guess.

## Step 0 — Endpoint and key handling

The **OTLP endpoint** is always `https://intake.superlog.sh`.

The **ingest API key** starts with `superlog_live_` and is project-scoped + write-only. It's a secret: **never embed it as a literal in source files.** It only ever goes into env files (`.env.local`, `.env.superlog`, the language equivalent) read at runtime.

Don't block on the key up front — instrumentation is mostly the same whether the key exists yet or not, and asking for it before the user has seen what they're getting kills the flow. Two paths:

- **If the user already has a key**, accept it and use it everywhere the env files want it.
- **If they don't** (no key visible in their existing config, no answer when you ask), use the literal sentinel `SUPERLOG_TEST` as the key. Superlog's ingest accepts `SUPERLOG_TEST` from anyone — it returns 200 to the OTLP exporter without forwarding anywhere. This lets the user's app boot, exercise the OTel bootstrap path, and emit telemetry calls end-to-end before they sign up. They swap `SUPERLOG_TEST` for a real `superlog_live_…` after signup and real telemetry starts flowing.

Either way, do the install work first. Sign-up happens at the end (Step 5).

## Step 1 — Map every app/service in the repo

Before instrumenting anything, enumerate what's here. Check workspace manifests (`pnpm-workspace.yaml`, root `package.json` `workspaces`, `go.work`, Cargo workspace, Python `pyproject.toml` workspace setups, `apps/*` and `services/*` conventions). Identify each ervice: web frontend, API, workers, background jobs, CLIs, sample/demo apps, mobile apps, Supabase and/or server functions. Skip pure type/config packages with no runtime entry point. Do not skip any runnable services or leave them 'out of scope': you must instrument absolutely everything in this run, there may be no follpwup.

Show the user the list before you start, so they can correct it.

## Step 2 — For each service, install native OTel and bootstrap

**Use the language's native OpenTelemetry SDK.** Don't reach for vendor wrappers or hand-rolled helpers when an official package exists. Examples of what "native" means here: `@opentelemetry/sdk-node` for Node servers, `@vercel/otel` for Next.js (sdk-node breaks Next's webpack), `@opentelemetry/sdk-trace-web` + browser exporters for Vite/SPA, `opentelemetry-instrumentation-*` + `opentelemetry-sdk` for Python, `go.opentelemetry.io/otel` for Go.

Wire all three signals — traces, logs, metrics. **Logs go through OTLP, not just stdout** — set up the OTel log bridge for the language so app logs (with their existing log levels and structured fields) carry the active `trace_id` / `span_id` automatically. The user's existing logger keeps working; you're just adding an OTLP handler/processor underneath.

Bootstrap rules:
- The bootstrap file must run before any framework imports. Use the language/framework's documented hook (`--import` flag, `instrumentation.ts`, top-of-`main.py` import, etc.).
- Read the endpoint and key from env. The bootstrap should fail loudly if either is missing.
- Use HTTP OTLP exporters, not gRPC. gRPC pulls in native bindings that break bundlers and complicate containers.
- Use the project's existing package manager (detect via lockfile).
- Prefer idempotent edits. If a config file already exists, edit don't overwrite.

**Coexist with existing observability vendors. Don't remove Sentry, Datadog, New Relic, Honeycomb, Logtail, Pino transports, etc.** OTel sits alongside them. The user explicitly wants both signals flowing during migration; ripping out the incumbent is not your call.

## Step 3 — Add custom spans, metrics, and logs around business operations

Auto-instrumentation gets you HTTP in/out, DB queries, framework lifecycle. That's the floor, not the ceiling. Read the project to find the operations a human operator would actually want to see when something looks wrong.

### Traces

Wrap **every business operation** with a span. Auto-instrumented spans are fine where they exist — but if an operation isn't already getting a span, add one.

- Naming: `domain.verb` (`order.process`, `payment.charge`, `email.send`, `agent.run`, `interview.create`, `job.<type>`).
- Attributes: entity IDs (order.id, user.id, workspace.id, tenant.id), counts, key boolean branch outcomes, model name / provider for LLM calls.
- Record exceptions: `span.recordException(err)` + `span.setStatus({ code: ERROR })` on failure paths.
- Skip trivial getters, pure transforms, internal helpers — anything with no real latency or failure mode.
- **Never put PII in attributes** (emails, passwords, tokens, full request bodies).

### Logs

Make sure logs are **structured and carry operation context**. Concretely: every log line emitted inside a span should arrive at Superlog with `trace_id` / `span_id` populated and any structured fields (orderId, userId, etc.) preserved as attributes. Trace/span context may be added natively by the log bridge or integration, or may require additional work.

Use logs for narrative ("starting batch reconcile", "retrying after 3xx") and exceptional events. An error log must only be emitted if the operation cannot recover and manual intervention is required.

### Metrics

Cover **business + performance + cost**. Three categories to look for:

- **Business logic counters.** Every meaningful state transition: created, started, completed, failed, retried. Per-tenant, per-channel, per-status — low-cardinality dimensions only (never user/order IDs).
- **Performance histograms.** Latency of operations the user cares about, queue depth, batch sizes, payload sizes. Reuse existing timing instrumentation if the project already has any (`time.perf_counter` blocks, custom `LatencyTracker`s, "[TIMING]" log lines) — emit a histogram from those measurements rather than measuring twice.
- **Costs — especially LLM costs.** If the project calls OpenAI / Anthropic / any LLM provider, record token counts and dollar costs as histograms or counters: `llm.tokens.input`, `llm.tokens.output`, `llm.cost_usd`, dimensioned by `model`, `provider`, and the calling `operation`. Same for any other paid API where requests have variable cost.

Get the meter once at module level, create instruments at module level, increment in the hot path. Don't create a fresh meter per call.

## Step 4 — Verify the app still works

Per service:

1. **Run the project's own dev or build command** (whatever its `package.json` / `pyproject` / `Makefile` already wires up). Confirm it starts cleanly with no errors that trace back to your OTel install. For a server, hit at least one route with curl so traffic flows through the instrumentation. For a CLI, invoke a real command. **Don't ship if the app's own startup is now broken** — that's a regression.
2. **Confirm telemetry leaves the process.** With `SUPERLOG_TEST` (or a real key) in env, OTLP POSTs from the dev server should return 2xx — that proves the bootstrap is reaching the network. As an extra sanity check, you can `curl -X POST https://ingest.superlog.sh/v1/traces -H "authorization: Bearer SUPERLOG_TEST" -H "content-type: application/json" -d '{}'` and confirm 200. The real signal is the running app's own POSTs succeeding by the time the dev server shuts down — if they don't, the bootstrap is wrong (most often: SDK loaded too late, or shutdown not flushing).

A bootstrap that loads but never POSTs is not a partial success. Fix it before moving on.

## Step 5 — Hand-off (final message to the user)

This is the closing message. Three blocks, in order. Auto-open the signup URL in the user's browser at the end.

### What changed

3–7 short factual bullets covering: packages installed, files created/modified, env vars written, business spans/metrics added. Per service if changes differed, grouped if uniform. Mention any existing observability vendor (Sentry, Datadog, Logtail, Pino transports, etc.) you intentionally left in place so the coexistence is explicit.

### Set these env vars to launch

Two env vars need to reach every runtime that runs the instrumented code (local dev, CI, prod):

- `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.superlog.sh`
- `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <key>` — `<key>` is `SUPERLOG_TEST` until they swap it for a real `superlog_live_…` after signup.

For local dev, point at the `.env.local` / `.env.superlog` file you wrote — already done. For deploy, give **concrete instructions for the targets you actually detected in the repo**:

- `Dockerfile` / `docker-compose.yml` → `docker run -e OTEL_EXPORTER_OTLP_ENDPOINT=… -e OTEL_EXPORTER_OTLP_HEADERS=…` (or service-level `environment:` in compose). Mention multi-stage builds shouldn't bake the key in.
- `vercel.json` / `.vercel/` → `vercel env add OTEL_EXPORTER_OTLP_HEADERS production` (and same for `OTEL_EXPORTER_OTLP_ENDPOINT`).
- `railway.json` / Railway already wired → `railway variables --set 'OTEL_EXPORTER_OTLP_HEADERS=…' --service <name>`.
- `fly.toml` → `fly secrets set OTEL_EXPORTER_OTLP_HEADERS=…`.
- `.github/workflows/*.yml` → repo Settings → Secrets → add as Actions secrets, then reference as `${{ secrets.OTEL_EXPORTER_OTLP_HEADERS }}` in the workflow.
- `Procfile` / Heroku → `heroku config:set OTEL_EXPORTER_OTLP_HEADERS=…`.
- Kubernetes manifests → add to a Secret and mount via `envFrom` / `valueFrom.secretKeyRef`.
- Otherwise → the generic shell-export form for whatever shell is in use.

Only mention targets that actually exist in the repo. Don't list every option as a wall of text.

### Get your key

Tell the user: "Opening Superlog signup in your browser — sign up, optionally connect GitHub, and copy your `superlog_live_…` key. Replace `SUPERLOG_TEST` in the env files / deploy targets above with it." Then auto-open:

- macOS: `open "https://superlog.sh/signup?from=skill"`
- Linux: `xdg-open "https://superlog.sh/signup?from=skill"`
- Windows: `start "" "https://superlog.sh/signup?from=skill"`

`?from=skill` tells the web app to skip its in-app install agent (you already did the work) and land the user on Settings with their key visible to copy.

If `open` / `xdg-open` isn't available or returns non-zero, just print the URL — don't fail the skill.

**Don't loop waiting for the user to paste the key back.** Once they swap `SUPERLOG_TEST` for the real key, telemetry starts flowing on its own at https://superlog.sh/dash.

### Suggest the Superlog MCP for next time

Before ending the skill, suggest installing the Superlog MCP server so the agent (Claude Code, Codex, Cursor, etc.) can query their telemetry directly the next time they're debugging — search logs, pull traces, check error rates from inside the chat without context-switching to the dashboard.

For Claude Code (which is what the user is running this skill in, by far the most likely case):

```
claude mcp add --transport http superlog https://api.superlog.sh/mcp
```

Mention but don't run the equivalents for other agents in case they use more than one:

- Codex: `codex mcp add superlog --url https://api.superlog.sh/mcp && codex mcp login superlog`
- Cursor / others: copy the `mcpServers` snippet from https://superlog.sh/dash → Connect.

Frame this as a suggestion, not a step you execute. The user has to opt in to MCP servers and may not want one yet.

## Hard rules

- Never modify files outside the project root.
- Never commit, push, or open PRs.
- Never embed the ingest key as a literal in source — env files only.
- Never remove an existing observability vendor unless the user asks for it.
- Use the project's existing package manager and existing logger.
- Prefer native OTel packages for the language; don't reinvent telemetry plumbing the SDK already provides.
- If the dev/build command errors out *because of* your instrumentation, that's a failure — fix it or report it, don't paper over it.
