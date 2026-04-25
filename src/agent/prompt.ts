import type { Detection, SubFramework } from "../detect.js";

export const AGENT_MARKERS = {
  status: "[SUPERLOG-STATUS]",
  tasks: "[SUPERLOG-TASKS]",
  taskDone: "[SUPERLOG-TASK-DONE]",
  report: "[SUPERLOG-REPORT]",
  recap: "[SUPERLOG-RECAP]",
  done: "[SUPERLOG-DONE]",
  partial: "[SUPERLOG-PARTIAL]",
  abort: "[SUPERLOG-ABORT]",
} as const;

export type AgentReport = {
  service: string;
  signals: ("traces" | "logs" | "metrics")[];
};

export type AgentRecap = {
  items: string[];
};

export type AgentInput = {
  cwd: string;
  detection: Detection;
  region: string;
  /** CLI session token (superlog_cli_*) — used only to route the agent SDK through the superlog LLM gateway. MUST NOT be written into project files. */
  token: string;
  /** Project-scoped ingest API key (superlog_live_*) — what the customer's runtime uses to POST telemetry. This is what ends up in .env.superlog. */
  ingestKey: string;
  gatewayUrl: string;
};

export function buildSystemPrompt(): string {
  return `You are the Superlog install agent. Your job is to instrument the user's project so OpenTelemetry traces, logs, and metrics stream to Superlog.

You MUST:
1. Install the correct OTel SDK packages for the detected framework using the project's package manager. Follow the framework-specific recipe in the task prompt — it supersedes any general instinct to use @opentelemetry/sdk-node, which is often wrong (e.g. it breaks webpack in Next.js).
2. Create the instrumentation bootstrap at the path the framework expects (e.g. \`instrumentation.ts\` at the project root for Next.js; a file imported at the top of \`main.py\` for Python).
3. Put the ingest key ONLY in an env file (\`.env.local\` if the framework auto-loads it, else \`.env.superlog\` with a note). The instrumentation source file must read from \`process.env\` (or the equivalent) and fail closed if the env var is missing. NEVER embed the literal ingest key in \`.ts\` / \`.js\` / \`.py\` / \`.go\` source — that leaks secrets into git.
4. Verify in two phases before printing \`${AGENT_MARKERS.done}\`:
   a) Instrumentation-loads check — run the project's own build or dev command (e.g. \`pnpm run dev\` / \`pnpm run build\`) and confirm it starts without errors from the OTel code. A standalone test script is NOT sufficient; it misses bundler/transitive-dep failures that only surface inside the framework's runtime.
   b) Ingest-reach check — with the app running, hit a route (for servers) or invoke the CLI (for CLIs) to generate real traffic, then POST a small test span to \`<endpoint>/v1/traces\` as a fallback sanity check. Both signals should be positive.
5. Before printing \`${AGENT_MARKERS.done}\` or \`${AGENT_MARKERS.partial}\`, emit exactly one report line per instrumented service:

   \`${AGENT_MARKERS.report} {"service": "<the service.name you configured>", "signals": ["traces", "logs", "metrics"]}\`

   The CLI uses this to query for the app's actual telemetry in storage. Include only the signals you wired up — if you did not configure a logger or a metric reader, omit "logs" or "metrics". The service name MUST match exactly what the instrumented app reports as OTel's \`service.name\` resource attribute.

6. Right before the terminal marker (\`${AGENT_MARKERS.done}\` or \`${AGENT_MARKERS.partial}\` — NOT \`${AGENT_MARKERS.abort}\`), emit exactly one recap line summarizing the concrete changes you made:

   \`${AGENT_MARKERS.recap} {"items": ["<one short factual phrase>", "..."]}\`

   Each item is one short phrase (≤ 90 chars) describing one concrete change: a package install, a file created, a file modified, env vars written, or a group of related edits (e.g. "Added custom spans around order.process, payment.charge, email.send"). Aim for 3–7 items — this is what the user sees as the post-install summary, so write it at the level of a tight PR description: factual, scannable, no marketing prose. For monorepos, include one item per instrumented package plus shared changes. Valid JSON only; the array is a flat list of strings.

7. Based on the verification outcome, print exactly one of the terminal markers below.

Terminal markers (pick exactly one, alone on a line):
- \`${AGENT_MARKERS.done}\` — instrumentation loads inside the framework AND ingest accepted a test span (HTTP 2xx).
- \`${AGENT_MARKERS.partial} <reason>\` — instrumentation loads correctly BUT ingest can't be confirmed. Use when:
  - DNS resolution fails (ENOTFOUND, EAI_AGAIN).
  - Connection refused / timeout / network unreachable.
  - Ingest returned 5xx (server-side problem, user config is fine).
  Soft-success — user's project is wired up, ingest just isn't reachable right now.
- \`${AGENT_MARKERS.abort} <reason>\` — something is genuinely broken and the user must fix it. Use when:
  - The project's dev/build command errors out *because of* your instrumentation (wrong API version, webpack resolution failure, import error).
  - Ingest returned 401/403/400 (auth or payload rejected).
  - Package install failed and you cannot recover.
  - You could not write required files.

Progress reporting:
- Before each significant action, print \`${AGENT_MARKERS.status} <short human-readable message>\` on its own line. The TUI parses these — keep them under 80 chars and single-line.
- Examples: \`${AGENT_MARKERS.status} Installing @vercel/otel\`, \`${AGENT_MARKERS.status} Writing instrumentation.ts\`, \`${AGENT_MARKERS.status} Starting dev server to verify\`, \`${AGENT_MARKERS.status} Sending test span\`.

Monorepo task list markers (only used when instrumenting a workspace with multiple packages):
- After discovering the packages to instrument, emit exactly one: \`${AGENT_MARKERS.tasks} [{"path": "relative/path", "framework": "hono"}, ...]\` — the CLI renders this as a checklist. Relative paths are relative to the workspace root.
- After finishing each package (success or partial), emit: \`${AGENT_MARKERS.taskDone} relative/path\` — the CLI marks that item done. Emit this even if the package was only partially instrumented.

Rules:
- Never modify files outside the project root.
- Never commit to git, never push, never open PRs.
- Prefer idempotent writes — if a config file already exists, edit rather than overwrite.
- Match the existing style: TypeScript if the project is TS, plain JS if JS.
- Do not install heavy unrelated dependencies.
- Use the project's existing package manager (detected via lockfile).
- Always suppress package install output to avoid flooding context: append \`> /dev/null 2>&1 || true\` to install commands and check the exit code separately if needed. Example: \`npm install @opentelemetry/sdk-node > /dev/null 2>&1; echo "exit:$?"\`.
- Never read a source file larger than 100 lines in full. Check size first with \`wc -l <file>\`. For files over 100 lines use \`grep -n "^export\\|^async function\\|^function\\|app\\.get\\|app\\.post\\|router\\." <file> | head -30\` to extract structure instead of reading the whole file.
- Never issue more than one Read tool call per turn. Read one file, process it, then decide what to read next. Sequential reads keep context predictable; parallel reads of several large files will overflow the window.
- Glob outputs with more than 20 paths should be filtered immediately: pipe through \`grep -v "node_modules\\|dist\\|\\.test\\." | head -20\`.`;
}

export function buildTaskPrompt(input: AgentInput): string {
  if (input.detection.runtime === "monorepo") {
    return monorepoTaskPrompt(input);
  }

  if (input.detection.runtime === "applescript") {
    return `Instrument this project:

- Project root: ${input.cwd}
- Runtime: applescript (macOS automation)
- Superlog OTLP endpoint: ${input.region}

Framework recipe:
${recipeFor(input.detection)}

Verification:
1. After each edit, confirm the edited script still compiles (\`osacompile\`). Any failure = ${AGENT_MARKERS.abort}.
2. Do NOT try to run the scripts to generate traffic — they are event-driven (Mail rules, Folder Actions, hotkeys) and invoking them out of context triggers real side effects.
3. Confirm ingest is reachable by POSTing a tiny OTLP log JSON to ${input.region}/v1/logs with \`authorization: Bearer ${input.ingestKey}\`. A 2xx confirms ingest; a 401/403/400 means ${AGENT_MARKERS.abort}; DNS/timeout/5xx means ${AGENT_MARKERS.partial}.
4. If the \`superlog-log\` helper is not installed yet, that is expected at this stage — emit ${AGENT_MARKERS.partial} with reason "on-host agent not yet installed; run \`brew install superloglabs/tap/superlog-agent\` next". Scripts are still instrumented; telemetry will flow once the agent is in place.

Print one terminal marker per the system prompt contract based on the combined outcome.`;
  }

  return `Instrument this project:

- Project root: ${input.cwd}
- Runtime: ${input.detection.runtime}
- Framework: ${input.detection.framework}
- Package manager: ${input.detection.packageManager}
- Superlog OTLP endpoint: ${input.region}
- Ingest API key: ${input.ingestKey}

--- STEP 1: UNDERSTAND THE CODEBASE ---

Before writing any code, read the project's source files to understand what it does. Focus on:
- Entry points and route handlers (what operations does the app expose?)
- Service / business logic layer (what does it compute or coordinate?)
- Background jobs, queue processors, scheduled tasks
- Integration points with external services (payments, emails, third-party APIs, databases)

Read selectively and small. Check line count before reading (\`wc -l\`). For files over 150 lines use \`grep -n\` to extract function/route names rather than reading the whole file. You're looking for the 5–10 operations that, if slow or broken, users would notice — a targeted grep will find them faster than reading everything.

--- STEP 2: INSTALL AND BOOTSTRAP ---

${recipeFor(input.detection)}
${subRecipeBlock(input.detection.subFrameworks)}
--- STEP 3: ADD CUSTOM SPANS ---

Using the operations identified in Step 1, add manual instrumentation on top of the auto-instrumentation from the bootstrap. Get the tracer once at the module level and reuse it:

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? "<service-name>");

Wrap each critical operation:

  // async handler example
  async function processOrder(orderId: string) {
    return tracer.startActiveSpan("order.process", async (span) => {
      try {
        span.setAttributes({ "order.id": orderId });
        const result = await doWork();
        span.setAttributes({ "order.total": result.total, "order.items": result.items.length });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

Naming: use "domain.verb" (e.g. "payment.charge", "email.send", "cache.invalidate", "incident.fingerprint", "agent.run").
Attributes: entity IDs, user IDs, counts, key boolean branch outcomes. Never log PII (emails, passwords, tokens, raw request bodies).
What to skip: trivial getters, pure data transforms, internal helpers, anything already covered by auto-instrumentation (HTTP in/out, DB queries). Only wrap operations with real latency or meaningful failure modes.

For browser/Vite projects, instrument key user interactions instead:

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  const tracer = trace.getTracer(import.meta.env.VITE_OTEL_SERVICE_NAME ?? "<service-name>");

  async function handleCheckout() {
    return tracer.startActiveSpan("checkout.submit", async (span) => {
      try {
        span.setAttributes({ "cart.items": cartItems.length });
        const result = await submitOrder();
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

--- STEP 4: VERIFY ---

1. Run the project's own dev or build command and confirm it completes without errors from the OTel code. For a web framework, start the dev server, wait for it to report ready, and hit a route with curl so traffic flows through your instrumentation. Kill the server when done.
2. As a fallback check that ingest is reachable, POST a tiny OTLP span JSON to ${input.region}/v1/traces with \`authorization: Bearer ${input.ingestKey}\`. A 2xx confirms ingest; a 401/403/400 means ${AGENT_MARKERS.abort}; DNS/timeout/5xx means ${AGENT_MARKERS.partial}.

Print one terminal marker per the system prompt contract based on the combined outcome.`;
}

function monorepoTaskPrompt(input: AgentInput): string {
  return `Instrument all application services in this monorepo.

Workspace root: ${input.cwd}
Package manager: ${input.detection.packageManager}
OTLP endpoint: ${input.region}
Ingest key: ${input.ingestKey}

STEP 1 — DISCOVERY

Read the workspace config (pnpm-workspace.yaml or package.json "workspaces") and check each package's package.json to identify its framework AND any sub-frameworks (libraries that need their own OTel wiring on top of the primary recipe). Skip pure type/config packages with no runtime entry point.

Sub-framework markers to look for in each package's deps + devDeps:
- \`@temporalio/worker\` → \`temporal-worker\`
- \`@temporalio/client\` (without \`@temporalio/worker\` in the same package) → \`temporal-client\`
- \`@livekit/agents\` → \`livekit-agents\`
- \`livekit-server-sdk\` → \`livekit-server\`
- \`livekit-client\` → \`livekit-client\`

Emit the task list (relative paths from workspace root). The \`subFrameworks\` array MUST be present on every entry, even if empty:
\`${AGENT_MARKERS.tasks} [{"path": "apps/api", "framework": "hono", "subFrameworks": ["temporal-client"]}, {"path": "apps/worker", "framework": "plain", "subFrameworks": ["temporal-worker"]}, ...]\`

STEP 2 — DISPATCH SUBAGENTS

Use the Agent tool to instrument each package in its own subagent. Dispatch them one at a time. For each, pass this prompt (fill in the blanks, including the sub-framework section if applicable):

---
Instrument the <framework> service at <absolute-package-path>.
OTLP endpoint: ${input.region}
Ingest key: ${input.ingestKey}
Package manager: ${input.detection.packageManager}
Sub-frameworks detected: <comma-separated list, or "none">

1. Read the entry point and key source files (check wc -l first; grep for exports/routes on files over 100 lines).
2. Install OTel packages and create a bootstrap file. Key constraints:
   - Next.js: use @vercel/otel (NOT sdk-node — webpack can't bundle grpc). Create instrumentation.ts with registerOTel(). Write env to .env.local.
   - Node.js server (Hono/Express/etc): use @opentelemetry/sdk-node with HTTP exporters only. Create tracing.ts, prepend --import ./tracing.ts to the dev/start script, write env to .env.superlog.
   - Vite/React: use @opentelemetry/sdk-trace-web + OTLPTraceExporter (HTTP). Create src/instrumentation.ts, import it first in src/main.tsx, write env to .env.local.
   - Always suppress install output: run installs with > /dev/null 2>&1; echo "exit:$?"
   - Env vars: OTEL_EXPORTER_OTLP_ENDPOINT=${input.region}, OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer ${input.ingestKey}, OTEL_SERVICE_NAME=<package.json name>
3. For each sub-framework in "Sub-frameworks detected", apply its layer on top of the base bootstrap (DO NOT replace the base):
   - \`temporal-worker\`: install \`@temporalio/interceptors-opentelemetry\`, register \`OpenTelemetryPlugin\` on \`Worker.create({ plugins: [...] })\` reusing the base SDK's \`Resource\` and \`SpanProcessor\`. CRITICAL: if the project also calls \`bundleWorkflowCode\`, pass the same plugins array there too or workflow tracing silently breaks. Grep for \`bundleWorkflowCode\` to check.
   - \`temporal-client\`: install \`@temporalio/interceptors-opentelemetry\`, register \`OpenTelemetryPlugin\` on the existing \`Client\` construction. Reuse the base \`Resource\`/\`SpanProcessor\`.
   - \`livekit-agents\` (Python): call \`livekit.agents.telemetry.set_tracer_provider(provider)\` from inside the entrypoint, and add a \`ctx.add_shutdown_callback(lambda: provider.force_flush())\` call. The framework auto-spans LLM/tools/TTS once registered. Mandatory force_flush — agent jobs are short-lived.
   - \`livekit-agents\` (Node): no built-in OTel module yet (livekit/agents-js#757). Add manual spans at the entrypoint, around each function_tool callback, and around explicit LLM/STT/TTS calls. Service name: \`<pkg>-agent\`.
   - \`livekit-server\`: wrap the \`RoomServiceClient\` methods the project actually calls (\`createRoom\`, \`deleteRoom\`, \`removeParticipant\`, etc.) with manual CLIENT-kind spans named \`livekit.room_service.<method>\`. Skip \`AccessToken.toJwt()\`.
   - \`livekit-client\`: wrap \`room.connect\`, \`localParticipant.publishTrack/unpublishTrack\`, \`room.disconnect\` with browser-side spans. Subscribe to \`RoomEvent.Reconnecting/Reconnected/Disconnected\` for lifecycle events on the active span.
4. Add custom spans around 3–5 critical business operations using trace.getTracer() from @opentelemetry/api. Use "domain.verb" naming. Record exceptions and set SpanStatusCode.ERROR on failure. Skip trivial helpers and anything already covered by auto-instrumentation. (Skip this step entirely if a Temporal worker is the only thing in the package — the interceptors already cover workflow/activity spans.)
5. Start the dev server, verify it loads cleanly, send a test span to ${input.region}/v1/traces. Kill the server.
6. Output exactly one JSON line: {"service":"<name>","signals":["traces","logs","metrics"],"status":"done|partial","reason":"<if partial>"}
---

After each subagent returns, parse its JSON output and emit:
\`${AGENT_MARKERS.report} {"service": "<name>", "signals": [...]}\`
\`${AGENT_MARKERS.taskDone} <relative-path>\`

STEP 3 — TERMINAL MARKER

After all packages: \`${AGENT_MARKERS.done}\` if all succeeded, \`${AGENT_MARKERS.partial} <reason>\` if any ingest checks failed, \`${AGENT_MARKERS.abort} <reason>\` if any package could not be instrumented.`;
}

function recipeFor(detection: Detection): string {
  if (detection.runtime === "applescript") {
    return appleScriptRecipe();
  }

  if (detection.framework === "next") {
    return nextRecipe();
  }

  if (detection.framework === "vite") {
    return browserRecipe();
  }

  if (detection.runtime === "node") {
    return nodeRecipe();
  }

  if (detection.framework === "fastapi") {
    return fastapiRecipe();
  }

  return genericRecipe(detection);
}

function genericRecipe(detection: Detection): string {
  return `No vetted Superlog recipe exists for this runtime/framework (detected: ${detection.runtime}/${detection.framework}). Wire it up best-effort using the canonical OpenTelemetry SDK for the language. Investigate the project before installing — check the entry point, dependency manifest, and run scripts so the bootstrap fires before any app code.

Canonical SDKs by runtime (use HTTP/protobuf exporters, never gRPC — gRPC pulls native deps that complicate containers and CI):

- python: \`opentelemetry-distro\`, \`opentelemetry-exporter-otlp-proto-http\`, \`opentelemetry-instrumentation\` plus the framework-specific instrumentation package (e.g. \`opentelemetry-instrumentation-fastapi\`, \`-django\`, \`-flask\`). Prefer the \`opentelemetry-instrument\` CLI wrapper on the start command when the project has a single entry binary; otherwise initialize a TracerProvider explicitly at the top of the main module before any framework imports.
- go: \`go.opentelemetry.io/otel\`, \`go.opentelemetry.io/otel/sdk\`, \`go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp\` (+ logs/metrics http exporters). Initialize the provider in \`main()\` before the HTTP server starts; defer \`provider.Shutdown()\`. Use the framework's contrib instrumentation if present (\`otelgin\`, \`otelecho\`, etc).
- unknown: read README and entry point, identify the actual language, then apply the matching list above. If the project has no obvious runtime, emit ${AGENT_MARKERS.abort} with reason "could not identify runtime — manual setup required".

Configuration contract (same for every language):
- Read the OTLP endpoint from \`OTEL_EXPORTER_OTLP_ENDPOINT\` and the auth header from \`OTEL_EXPORTER_OTLP_HEADERS\` (\`authorization=Bearer <key>\`). Set \`OTEL_SERVICE_NAME\` to the project name.
- Never embed the ingest key as a literal in source. Write it to an env file the runtime auto-loads (\`.env\`, \`.env.local\`) if one exists, otherwise \`.env.superlog\` plus a one-line note in the bootstrap comment telling the user how to load it (e.g. \`source .env.superlog\`, \`--env-file\`, dotenv).
- Fail closed: if the env vars are missing at startup, raise/panic with a message naming the missing var. Silent no-op installs are worse than a loud failure.

Bootstrap placement:
- Must execute before any framework or app imports. For Python, that means top of \`main.py\` / \`asgi.py\` / \`wsgi.py\` or via \`opentelemetry-instrument\` on the run command. For Go, top of \`main()\` before \`http.ListenAndServe\`. For other runtimes, find the equivalent and use it.
- Prefer editing the existing run/start command over modifying app source when a CLI wrapper exists.

Verification:
- Run the project's own dev/build/start command (whatever package.json / Makefile / pyproject scripts / go run is wired up to). Confirm it starts without errors traceable to the OTel install. A standalone test script is NOT sufficient — bundler, native-dep, and transitive-import failures only surface inside the real runtime.
- Generate one unit of real traffic (hit a route, invoke the CLI, etc).
- Then POST a small OTLP test span to \`<endpoint>/v1/traces\` with the bearer header as a fallback ingest sanity check.
- Map outcomes to terminal markers per the system-prompt contract: clean run + 2xx test span = ${AGENT_MARKERS.done}; clean run but ingest unreachable = ${AGENT_MARKERS.partial}; runtime errors caused by your install = ${AGENT_MARKERS.abort}.`;
}

function nextRecipe(): string {
  return `Next.js — use \`@vercel/otel\`, NOT \`@opentelemetry/sdk-node\`. sdk-node transitively pulls in \`@grpc/grpc-js\`, which webpack cannot bundle (fails with "Module not found: Can't resolve 'stream'"). @vercel/otel is Vercel's maintained wrapper that handles Next.js's runtime split and OTel 2.x API changes.

Install: \`@vercel/otel\` and \`@opentelemetry/api\`. Nothing else — @vercel/otel brings its own exporters.

Create \`instrumentation.ts\` at the project root:

  import { registerOTel } from "@vercel/otel";

  export function register() {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || !process.env.OTEL_EXPORTER_OTLP_HEADERS) {
      throw new Error(
        "Superlog env vars missing — copy .env.superlog contents into .env.local before starting Next.js.",
      );
    }
    registerOTel({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "<derive from package.json name>",
    });
  }

Write env to \`.env.local\` at the project root (Next.js auto-loads it; do NOT write to \`.env.superlog\` unless .env.local already exists and you need to avoid clobbering it):

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint from above>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key from above>
  OTEL_SERVICE_NAME=<the "name" field from package.json>

@vercel/otel picks up OTEL_EXPORTER_OTLP_* automatically. Never put the key in instrumentation.ts.

Verify by running the project's dev command (check the "dev" script in package.json), waiting for Next.js to log "Ready" / "Local:", and hitting one route with curl. Watch for errors like "Resource is not a constructor" or "Module not found" — those mean the instrumentation file is wrong.`;
}

function nodeRecipe(): string {
  return `Node.js server (Hono, Express, Fastify, NestJS, or plain Node.js) — use \`@opentelemetry/sdk-node\` with HTTP-only OTLP exporters. Do NOT use gRPC exporters (\`@opentelemetry/exporter-trace-otlp-grpc\`) — they pull in \`@grpc/grpc-js\` with native binaries that complicate containerization and CI.

Install:
  @opentelemetry/sdk-node
  @opentelemetry/auto-instrumentations-node
  @opentelemetry/exporter-trace-otlp-http
  @opentelemetry/exporter-logs-otlp-http
  @opentelemetry/exporter-metrics-otlp-http
  @opentelemetry/sdk-metrics
  @opentelemetry/sdk-logs
  @opentelemetry/api

Create \`tracing.ts\` at the project root (or \`src/tracing.ts\` if a \`src/\` directory exists):

  import { NodeSDK } from "@opentelemetry/sdk-node";
  import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
  import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
  import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
  import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
  import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
  import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || !process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    throw new Error(
      "Superlog env vars missing — copy .env.superlog contents into your environment before starting.",
    );
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation generates thousands of spans per second in typical servers
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.on("SIGTERM", () => { sdk.shutdown(); });

The OTLP exporters read OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS from the environment automatically when constructed without arguments. Never pass the ingest key as a literal string in tracing.ts.

Bootstrap — tracing.ts MUST execute before any other imports. Two options depending on how the project starts:

Option A (preferred if the project uses tsx or ts-node): prepend \`--import ./tracing.ts\` to the tsx/ts-node invocation in the dev/start script in package.json. Example:
  "start": "tsx --import ./tracing.ts src/index.ts"
  "dev": "tsx watch --import ./tracing.ts src/index.ts"

Option B (if the entry file is plain JS/TS without a loader flag): add \`import "./tracing.js"\` as the very first line of the entry file (before any framework or app imports).

Check the existing "dev" and "start" scripts in package.json to decide which option fits. Prefer Option A because it avoids touching application code.

Write env to \`.env.superlog\` at the project root. If the project already uses dotenv, add \`require("dotenv").config({ path: ".env.superlog" })\` at the top of tracing.ts (before the env check). If it uses Node 20+ \`--env-file\`, add \`--env-file .env.superlog\` to the start script instead.

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint from above>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key from above>
  OTEL_SERVICE_NAME=<the "name" field from package.json>

Signals: traces + logs + metrics (NodeSDK wires all three via the explicit exporters above).`;
}

function browserRecipe(): string {
  return `Vite / React (browser) — use \`@opentelemetry/sdk-trace-web\` with the OTLP HTTP exporter. Metrics are not covered (browser metrics SDK is not stable). Vite exposes env vars to the browser only when prefixed with \`VITE_\`.

Install:
  @opentelemetry/sdk-trace-web
  @opentelemetry/sdk-trace-base
  @opentelemetry/exporter-trace-otlp-http
  @opentelemetry/instrumentation-fetch
  @opentelemetry/instrumentation
  @opentelemetry/resources
  @opentelemetry/semantic-conventions
  @opentelemetry/api

Create \`src/instrumentation.ts\`:

  import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
  import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
  import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
  import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
  import { registerInstrumentations } from "@opentelemetry/instrumentation";
  import { resourceFromAttributes } from "@opentelemetry/resources";
  import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

  const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;
  const ingestKey = import.meta.env.VITE_SUPERLOG_INGEST_KEY;
  const serviceName = import.meta.env.VITE_OTEL_SERVICE_NAME ?? "<derive from package.json name>";

  if (!endpoint || !ingestKey) {
    console.warn("[superlog] Missing VITE_OTEL_EXPORTER_OTLP_ENDPOINT or VITE_SUPERLOG_INGEST_KEY — telemetry disabled");
  } else {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: \`\${endpoint}/v1/traces\`,
            headers: { authorization: \`Bearer \${ingestKey}\` },
          }),
          { scheduledDelayMillis: 1000, maxQueueSize: 512 },
        ),
      ],
    });

    provider.register();

    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({
          // propagate trace context to all fetch targets; narrow this to your API origin if needed
          propagateTraceHeaderCorsUrls: [/.*/],
        }),
      ],
    });
  }

Add \`import "./instrumentation"\` as the very first line of the Vite entry file (typically \`src/main.tsx\` or \`src/main.ts\`) — before React, before any other imports.

Write env to \`.env.local\` at the project root (Vite auto-loads it and gitignores it by default):

  VITE_OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint from above>
  VITE_SUPERLOG_INGEST_KEY=<the ingest API key from above>
  VITE_OTEL_SERVICE_NAME=<the "name" field from package.json>

Important caveats:

1. CORS — the browser sends a preflight OPTIONS request before each OTLP POST. The Superlog endpoint must return Access-Control-Allow-Origin and Access-Control-Allow-Headers (authorization, content-type) for the app's origin. Verify before claiming success:
     curl -s -o /dev/null -w "%{http_code}" -X OPTIONS <endpoint>/v1/traces \\
       -H "Origin: http://localhost:5173" \\
       -H "Access-Control-Request-Headers: authorization,content-type"
   A 2xx with CORS headers = OK. Absent or 4xx = emit ${AGENT_MARKERS.partial} with reason "OTLP endpoint does not allow browser-origin requests; CORS must be enabled on the collector".

2. Ingest key in bundle — VITE_SUPERLOG_INGEST_KEY will be included in the compiled JS bundle and visible to anyone who loads the page. This is intentional: the ingest key is project-scoped and write-only (it cannot read data). Still, commit it only to \`.env.local\`, never hardcode it in source.

Signals: traces only.`;
}

function fastapiRecipe(): string {
  return `FastAPI (Python) — use \`opentelemetry-instrumentation-fastapi\` driven by the \`opentelemetry-instrument\` CLI wrapper. Do NOT use the gRPC OTLP exporter (\`opentelemetry-exporter-otlp-proto-grpc\`); it pulls in \`grpcio\` with native wheels that complicate Docker/CI builds. The HTTP/protobuf exporter is pure-Python and ingests at the same OTLP endpoint.

Install (use the project's package manager — \`pip install\` for requirements.txt projects, \`poetry add\` for pyproject.toml/poetry, \`uv add\` for uv-managed projects):
  opentelemetry-distro
  opentelemetry-exporter-otlp-proto-http
  opentelemetry-instrumentation-fastapi
  opentelemetry-instrumentation-logging
  opentelemetry-instrumentation-requests
  opentelemetry-instrumentation-httpx
  opentelemetry-instrumentation-asyncpg     # only if asyncpg is used
  opentelemetry-instrumentation-psycopg     # only if psycopg is used
  opentelemetry-instrumentation-sqlalchemy  # only if SQLAlchemy is used
  opentelemetry-instrumentation-redis       # only if redis is used

Skip DB/cache instrumentations the project doesn't actually depend on — check the manifest first. Suppress install output: append \`> /dev/null 2>&1; echo "exit:$?"\`.

Bootstrap — preferred path is the \`opentelemetry-instrument\` CLI wrapper. Identify how the project starts uvicorn / hypercorn / fastapi-cli (check pyproject scripts, Procfile, Dockerfile CMD, README, or a shell script in the repo root). Prepend \`opentelemetry-instrument\` to that command. Examples:

  uvicorn app.main:app --host 0.0.0.0 --port 8000
  → opentelemetry-instrument uvicorn app.main:app --host 0.0.0.0 --port 8000

  fastapi run app/main.py
  → opentelemetry-instrument fastapi run app/main.py

  python -m app
  → opentelemetry-instrument python -m app

If the project has a \`scripts\` entry in pyproject.toml ([tool.poetry.scripts] or [project.scripts]) that wraps the start command, edit that script's invocation rather than every call site. If the project starts via \`if __name__ == "__main__": uvicorn.run(...)\`, the CLI wrapper still works — wrap \`python <entry>.py\`.

Fallback path (only if the start command can't be wrapped — e.g. the project embeds uvicorn.run() inside a function called from elsewhere): create a \`tracing.py\` module at the project root and import it as the very first line of the entry module, before \`from fastapi import FastAPI\`:

  # tracing.py
  import os
  from opentelemetry import trace
  from opentelemetry.sdk.resources import Resource
  from opentelemetry.sdk.trace import TracerProvider
  from opentelemetry.sdk.trace.export import BatchSpanProcessor
  from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
  from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
  from opentelemetry.instrumentation.logging import LoggingInstrumentor
  from opentelemetry.instrumentation.requests import RequestsInstrumentor

  if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or not os.getenv("OTEL_EXPORTER_OTLP_HEADERS"):
      raise RuntimeError(
          "Superlog env vars missing — load .env.superlog before starting (e.g. \`set -a; source .env.superlog; set +a\`)."
      )

  resource = Resource.create({"service.name": os.getenv("OTEL_SERVICE_NAME", "<derive-from-pyproject>")})
  provider = TracerProvider(resource=resource)
  provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
  trace.set_tracer_provider(provider)

  LoggingInstrumentor().instrument(set_logging_format=True)
  RequestsInstrumentor().instrument()
  # FastAPIInstrumentor.instrument_app(app) is called from main.py after \`app = FastAPI(...)\`

Then in the entry module:

  import tracing  # noqa: F401  -- must be first, before any framework imports
  from fastapi import FastAPI
  from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

  app = FastAPI()
  FastAPIInstrumentor.instrument_app(app)

Prefer the CLI wrapper. The fallback exists because some projects can't be wrapped cleanly (e.g. embedded uvicorn invocations behind a custom CLI).

Env vars — write to \`.env.superlog\` at the project root (FastAPI projects don't auto-load .env unless they use python-dotenv or pydantic-settings; check the project before assuming). Always set \`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\` — the Python OTLP SDK defaults to gRPC and will fail to export over the HTTP-only Superlog endpoint without it.

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint from above>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key from above>
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  OTEL_SERVICE_NAME=<the project name from pyproject.toml [project] or [tool.poetry], or the repo dir name>
  OTEL_PYTHON_LOG_CORRELATION=true
  OTEL_LOGS_EXPORTER=otlp
  OTEL_METRICS_EXPORTER=otlp
  OTEL_TRACES_EXPORTER=otlp

If the project already loads a .env via python-dotenv or pydantic-settings, append these to that .env instead of creating .env.superlog. Never embed the ingest key as a literal in source.

Custom spans — use the standard \`opentelemetry.trace\` API:

  from opentelemetry import trace
  tracer = trace.get_tracer(__name__)

  async def process_order(order_id: str):
      with tracer.start_as_current_span("order.process") as span:
          span.set_attribute("order.id", order_id)
          try:
              result = await do_work()
              span.set_attribute("order.total", result.total)
              return result
          except Exception as exc:
              span.record_exception(exc)
              span.set_status(trace.StatusCode.ERROR)
              raise

Verification — start the app the way the project normally starts it (with the wrapper applied), wait for uvicorn to log "Application startup complete", and curl one route. Watch for "Failed to export" / "Connection refused" / "Transient error" in the OTel logs — those indicate the HTTP endpoint or auth header is wrong. Kill the server when done. Then POST a small OTLP test span to <endpoint>/v1/traces with \`authorization: Bearer <key>\` as a fallback ingest sanity check.

Signals: traces + logs + metrics (the distro wires all three when the OTEL_*_EXPORTER vars are set).`;
}

function appleScriptRecipe(): string {
  return `AppleScript (macOS automation) — instrument each script to emit handler-level start/end events via the \`superlog-log\` helper binary. The helper appends to \`~/Library/Logs/Superlog/scripts.ndjson\`; a Collector tails that file and ships to Superlog.

Scope:
- Find every \`.applescript\` (text source), \`.scpt\` (compiled), and \`.scptd\` (bundle, contains a compiled script at \`Contents/Resources/Scripts/main.scpt\`) under the project root using Glob.
- Skip anything under \`node_modules\`, \`.git\`, or paths the project explicitly excludes.

Helper path resolution — run \`brew --prefix\` ONCE at the start and use \`<prefix>/bin/superlog-log\` as the absolute path in every injected \`do shell script\`. The PATH available inside \`do shell script\` is minimal; always use the absolute path. If \`brew\` is not installed, default to \`/usr/local/bin/superlog-log\` and note it in your report.

Editing workflow per file:
- \`.applescript\` (text): edit in place.
- \`.scpt\` (compiled): copy the original to \`<file>.pre-superlog\` first. Then \`osadecompile <file> > /tmp/sl-<basename>.applescript\`, apply the transformation to that text, then \`osacompile -o <file> /tmp/sl-<basename>.applescript\`. If \`osacompile\` fails, restore from \`.pre-superlog\` and mark the file as failed.
- \`.scptd\` (bundle): treat \`<bundle>/Contents/Resources/Scripts/main.scpt\` as a \`.scpt\` file.

Terminator subroutine — inject this block ONCE per file, at the very top (before any handlers). Replace \`<HELPER>\` with the resolved absolute helper path:

  on _slEnd(returnValue, runId, handlerName)
    try
      do shell script "<HELPER> event " & quoted form of ("{\\"e\\":\\"end\\",\\"s\\":\\"" & handlerName & "\\",\\"r\\":\\"" & runId & "\\",\\"status\\":\\"ok\\"}")
    end try
    return returnValue
  end _slEnd

Transformation per handler. For each \`on <name>(<params>) ... end <name>\` block (including implicit top-level for scripts without handlers — wrap the whole body), rewrite the body like this:

  on <name>(<params>)
    set _slRun to do shell script "uuidgen"
    try
      do shell script "<HELPER> event " & quoted form of ("{\\"e\\":\\"start\\",\\"s\\":\\"<name>\\",\\"r\\":\\"" & _slRun & "\\"}")
    end try
    try
      <original body, with EVERY \`return <expr>\` rewritten to \`return my _slEnd(<expr>, _slRun, "<name>")\`>
      my _slEnd(missing value, _slRun, "<name>")
    on error errMsg number errNum
      try
        do shell script "<HELPER> event " & quoted form of ("{\\"e\\":\\"end\\",\\"s\\":\\"<name>\\",\\"r\\":\\"" & _slRun & "\\",\\"status\\":\\"error\\",\\"code\\":" & errNum & "}")
      end try
      error errMsg number errNum
    end try
  end <name>

Why this pattern: placing end-ok after the original body is dead code when the body contains a \`return\` statement — the handler exits before the log call is reached. The terminator subroutine intercepts every return path: \`return my _slEnd(val, ...)\` logs end-ok then passes \`val\` through unchanged; the trailing \`my _slEnd(missing value, ...)\` fires only when the body falls off the end with no explicit return. Either way exactly one end event is emitted per invocation.

Return rewrite rules:
- Rewrite \`return someValue\` → \`return my _slEnd(someValue, _slRun, "<name>")\`
- Rewrite \`return\` (bare, no value) → \`return my _slEnd(missing value, _slRun, "<name>")\`
- The \`my\` keyword is required — it disambiguates a subroutine call from a property access inside a handler.
- Do NOT rewrite \`return\` statements that are inside nested handlers within the same file — only rewrite returns that belong to the handler currently being instrumented.

Critical invariants (do NOT relax):
- Every helper call (including inside \`_slEnd\`) is wrapped in its own inner \`try\`. Logging failure must never break the host script.
- The outer error handler ALWAYS re-raises with \`error errMsg number errNum\`. Never swallow. Re-raise preserves the script's exit behavior exactly — the whole point of this instrumentation approach.
- Do not include the error message string in the JSON payload: AppleScript errors can contain quotes/newlines that are a pain to escape safely in shell. Pass only the numeric code.
- Do not add \`display dialog\`, \`say\`, or any UI side effects.

Smoketest after each edit:
- Text scripts: \`osacompile -o /tmp/sl-smoke.scpt <edited-file>\`. Nonzero exit = your edit broke syntax. Revert the file.
- Compiled scripts: the \`osacompile -o <original> ...\` step IS the smoketest; the \`.pre-superlog\` backup is your recovery path on failure.

Handler discovery hints:
- Folder Actions enter via \`on adding folder items to this_folder after receiving these_items\` and friends — instrument each such handler found in the file.
- Mail rules enter via \`on perform mail action with messages theMessages for rule theRule\`.
- Many scripts have no explicit handler and are entirely top-level. Wrap the top-level body as if it were a single implicit handler named after the file (e.g., a file \`sync-inbox.applescript\` gets \`s: "sync-inbox"\`).

Do not run the scripts. Many of these scripts are wired into live workflows (Mail, Folder Actions) — invoking them out of context will trigger real side effects. Compilation smoketest is the only local verification you perform.

Service name for the SUPERLOG-REPORT marker: use the basename of the project directory. Signals: \`["logs"]\` (we ingest handler events as logs for now; spans can be derived downstream).`;
}

// Assembles 0..N sub-framework sections under a single "ADDITIONAL INTEGRATIONS"
// header. Each section layers on top of the primary framework's bootstrap from
// the recipe above — never replaces it. Returns "" when no sub-frameworks were
// detected so the prompt collapses cleanly.
function subRecipeBlock(subs: SubFramework[]): string {
  if (subs.length === 0) return "";
  const sections = subs.map(subRecipeFor).filter((s) => s.length > 0);
  if (sections.length === 0) return "";
  return `
--- STEP 2.5: ADDITIONAL INTEGRATIONS ---

The base bootstrap above stays as-is. The integrations below need their own OTel wiring on top of it. Apply each section after the base SDK is up and running.

${sections.join("\n\n")}
`;
}

function subRecipeFor(sub: SubFramework): string {
  switch (sub) {
    case "temporal-worker":
      return temporalWorkerRecipe();
    case "temporal-client":
      return temporalClientRecipe();
    case "livekit-agents":
      return liveKitAgentsRecipe();
    case "livekit-server":
      return liveKitServerRecipe();
    case "livekit-client":
      return liveKitClientRecipe();
  }
}

function temporalWorkerRecipe(): string {
  return `### Temporal worker — \`@temporalio/interceptors-opentelemetry\`

This project runs a Temporal Worker. Temporal's Node SDK ships an official OTel integration that wires interceptors across client + worker + workflow + activity in one shot.

Install:
  @temporalio/interceptors-opentelemetry

Wire it via the \`OpenTelemetryPlugin\` on \`Worker.create\`. Reuse the \`Resource\` and \`SpanProcessor\` from the base SDK bootstrap rather than constructing new ones — the plugin owns its own \`TracerProvider\` internally for workflow-isolate replay safety, but it needs the resource + processor to push spans through your existing exporter.

  import { Worker } from "@temporalio/worker";
  import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";

  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: "<existing-queue>",
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

If the project also constructs a Temporal \`Client\` (for starting workflows from an HTTP route), pass the SAME plugin instance there too:

  import { Client, Connection } from "@temporalio/client";

  const client = new Client({
    connection: await Connection.connect(),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

Critical workflow-bundle gotcha: workflow code runs in an isolated v8 context that cannot import your normal OTel SDK. The plugin handles this by injecting a workflow-side interceptor module into the workflow bundle — but ONLY if the bundle picks up its plugin config. If the project pre-bundles workflows via \`bundleWorkflowCode(...)\` (rather than letting \`Worker.create\` bundle from \`workflowsPath\`), you MUST pass the same \`plugins\` array there too:

  await bundleWorkflowCode({
    workflowsPath: require.resolve("./workflows"),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

Without that, workflow tracing silently breaks — workflows run, spans just never appear. Grep for \`bundleWorkflowCode\` before declaring success; if found, the plugins arg must be present.

Span names follow \`StartWorkflow:<WorkflowName>\`, \`RunWorkflow:<WorkflowName>\`, \`RunActivity:<ActivityName>\` — no naming work needed. Skip wrapping individual activities/workflows in your own custom spans; the interceptor already covers them. Custom spans should target business operations INSIDE activities (the activity span becomes the parent automatically).

Caveats:
- \`OpenTelemetryPlugin\` is marked \`@experimental\` in the SDK. The official \`samples-typescript/interceptors-opentelemetry\` repo uses it, so it's the canonical path despite the marker.
- The plugin handles spans only. Temporal's Rust core metrics ship through \`Runtime.install({ telemetryOptions: ... })\` — separate concern, leave alone unless the user asks for it.
- Workflow code uses W3C trace propagation by default. If the host app uses a non-W3C propagator (Jaeger, B3), register a \`CompositePropagator\` at the top of the workflow file too.`;
}

function temporalClientRecipe(): string {
  return `### Temporal client — \`@temporalio/interceptors-opentelemetry\`

This project uses Temporal as a client only (starting workflows from HTTP routes or background jobs — no \`Worker.create\` here). Wire the OTel plugin onto the \`Client\` so trace context propagates from the calling request into the workflow.

Install:
  @temporalio/interceptors-opentelemetry

Wire \`OpenTelemetryPlugin\` on the existing \`Client\` construction, reusing the \`Resource\` and \`SpanProcessor\` from the base SDK bootstrap:

  import { Client, Connection } from "@temporalio/client";
  import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";

  const client = new Client({
    connection: await Connection.connect(),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

That's the whole client-side recipe. Workflow execution traces are produced by whatever Worker is on the other end — if the worker isn't also instrumented, you'll only see the client-side \`StartWorkflow:<Name>\` span linking out, then a gap. That's expected and worth telling the user in the recap if you can detect that the worker is in a different repo.

Caveat: the plugin is marked \`@experimental\` in the SDK source. It IS the canonical path per the official samples — just flag it if asked.`;
}

function liveKitAgentsRecipe(): string {
  // Branch on Python vs Node at recipe-application time. Node has no built-in
  // OTel hook (livekit/agents-js#757); Python has set_tracer_provider which
  // auto-spans LLM/tools/TTS.
  return `### LiveKit Agents

LiveKit Agents has different OTel support depending on the language. Check whether this project is the Node (\`@livekit/agents\`) or Python (\`livekit-agents\`) flavor before applying.

**Python (\`livekit-agents\`) — built-in OTel hook**

Use \`livekit.agents.telemetry.set_tracer_provider\` from inside the entrypoint. Once registered, the framework auto-creates spans for the agent session, LLM calls, function tools, and TTS — no manual span work needed for the standard pipeline.

  from livekit.agents import JobContext
  from livekit.agents.telemetry import set_tracer_provider
  from opentelemetry.sdk.trace import TracerProvider
  from opentelemetry.sdk.trace.export import BatchSpanProcessor
  from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

  async def entrypoint(ctx: JobContext):
      provider = TracerProvider()
      provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
      set_tracer_provider(provider, metadata={"livekit.session.id": ctx.room.name})

      ctx.add_shutdown_callback(lambda: provider.force_flush())

      # ... existing AgentSession.start(...) code stays as-is

Critical: \`force_flush()\` in the shutdown callback is mandatory. Agent jobs are short-lived; without an explicit flush, the BatchSpanProcessor drops the tail spans when the job exits.

The base Python recipe above sets up the global \`TracerProvider\`. Either reuse that provider here (preferred — pass it into \`set_tracer_provider\` directly) or let this be the registration point and skip the duplicate base setup. Don't construct two providers.

**Node (\`@livekit/agents\`) — no built-in OTel, manual spans only**

\`@livekit/agents\` does not yet have a tracing module (tracking issue: livekit/agents-js#757). The base Node SDK bootstrap already gives you HTTP/fetch auto-instrumentation, which covers the WebSocket signaling and HTTP API surface. For the agent-specific work, add manual spans at three layers:

1. **Entrypoint** — wrap the body of your \`entry\` / \`entrypoint\` function in one root span per session: \`livekit.agent.session\`. Set attributes for the room name and participant identity.

2. **Function tools** — wrap each tool callback in a child span named \`livekit.tool.<toolName>\`. Set the args (excluding PII) as attributes.

3. **LLM/STT/TTS adapter calls** — if the project calls into LLM/STT/TTS adapters explicitly (rather than only via the framework's pipeline), wrap those calls in spans named \`llm.chat\`, \`stt.transcribe\`, \`tts.synthesize\`. The framework also fires its own internal events for these — leaving them unspanned is fine if the user prefers minimal instrumentation.

Use the standard \`tracer.startActiveSpan\` pattern with \`span.recordException\` + \`SpanStatusCode.ERROR\` on failure (see STEP 3 in the base instructions). Don't try to monkeypatch the framework — wait for the official OTel module instead.

Service name: use \`<package.json name>-agent\` (e.g. \`my-app-agent\`) to distinguish the agent process from any sibling HTTP service.`;
}

function liveKitServerRecipe(): string {
  return `### LiveKit Server SDK — \`livekit-server-sdk\`

This is the thin REST/JWT client used to mint access tokens and call LiveKit's \`RoomService\` from your backend. It has no streaming runtime, so the base framework's HTTP auto-instrumentation already covers most of the surface area (incoming requests that issue tokens get spanned automatically).

Targeted manual spans worth adding — wrap each \`RoomServiceClient\` method the project actually calls:

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? "<service-name>");

  async function endRoom(roomName: string) {
    return tracer.startActiveSpan("livekit.room_service.deleteRoom", async (span) => {
      try {
        span.setAttributes({ "livekit.room": roomName });
        await roomService.deleteRoom(roomName);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

Method names worth wrapping (only the ones the codebase actually calls — don't add spans for unused surface): \`createRoom\`, \`deleteRoom\`, \`listRooms\`, \`listParticipants\`, \`removeParticipant\`, \`mutePublishedTrack\`, \`updateParticipant\`, \`sendData\`, \`updateRoomMetadata\`. Likewise for \`EgressClient\`, \`IngressClient\`, \`SipClient\` if used.

Span attribute conventions: \`livekit.room\`, \`livekit.participant.identity\`, \`livekit.track.sid\` where applicable.

Skip: \`AccessToken.toJwt()\` — pure local JWT signing, no I/O, no value in spanning. The HTTP route that issues the token is already auto-instrumented.`;
}

function liveKitClientRecipe(): string {
  return `### LiveKit Client (browser) — \`livekit-client\`

This project uses the LiveKit browser SDK to join rooms and publish tracks. The base browser recipe already wires fetch instrumentation; layer LiveKit-specific spans for the room lifecycle on top.

Wrap these methods directly with spans (use the existing browser tracer from STEP 2):

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  import { Room, RoomEvent, DisconnectReason } from "livekit-client";

  const tracer = trace.getTracer(import.meta.env.VITE_OTEL_SERVICE_NAME ?? "<service-name>");

  async function joinRoom(url: string, token: string) {
    return tracer.startActiveSpan("livekit.room.connect", async (span) => {
      try {
        const room = new Room();
        await room.connect(url, token);
        span.setAttributes({
          "livekit.room": room.name,
          "livekit.participant.identity": room.localParticipant.identity,
        });
        return room;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

Wrap likewise: \`room.localParticipant.publishTrack\` → \`livekit.track.publish\`, \`room.localParticipant.unpublishTrack\` → \`livekit.track.unpublish\`, \`room.disconnect()\` → \`livekit.room.disconnect\`.

For passive lifecycle events (the user didn't initiate them), subscribe to \`RoomEvent\` and either start short child spans or add events to the active span:

  room.on(RoomEvent.Reconnecting, () => activeSpan?.addEvent("livekit.reconnecting"));
  room.on(RoomEvent.Reconnected, () => activeSpan?.addEvent("livekit.reconnected"));
  room.on(RoomEvent.Disconnected, (reason: DisconnectReason) => {
    activeSpan?.setAttributes({ "livekit.disconnect.reason": DisconnectReason[reason] });
  });

Span attribute conventions: \`livekit.room\`, \`livekit.participant.identity\`, \`livekit.track.sid\`, \`livekit.track.source\`, \`livekit.track.kind\`.

CORS reminder: same caveat as the base browser recipe — the OTLP endpoint must allow the app's origin. Already covered by the verification step there.`;
}
