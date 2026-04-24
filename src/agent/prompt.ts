import type { Detection } from "../detect.js";

export const AGENT_MARKERS = {
  status: "[SUPERLOG-STATUS]",
  tasks: "[SUPERLOG-TASKS]",
  taskDone: "[SUPERLOG-TASK-DONE]",
  report: "[SUPERLOG-REPORT]",
  done: "[SUPERLOG-DONE]",
  partial: "[SUPERLOG-PARTIAL]",
  abort: "[SUPERLOG-ABORT]",
} as const;

export type AgentReport = {
  service: string;
  signals: ("traces" | "logs" | "metrics")[];
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

6. Based on the verification outcome, print exactly one of the terminal markers below.

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

Read the workspace config (pnpm-workspace.yaml or package.json "workspaces") and check each package's package.json to identify its framework. Skip pure type/config packages with no runtime entry point.

Emit the task list (relative paths from workspace root):
\`${AGENT_MARKERS.tasks} [{"path": "apps/api", "framework": "hono"}, ...]\`

STEP 2 — DISPATCH SUBAGENTS

Use the Agent tool to instrument each package in its own subagent. Dispatch them one at a time. For each, pass this prompt (fill in the blanks):

---
Instrument the <framework> service at <absolute-package-path>.
OTLP endpoint: ${input.region}
Ingest key: ${input.ingestKey}
Package manager: ${input.detection.packageManager}

1. Read the entry point and key source files (check wc -l first; grep for exports/routes on files over 100 lines).
2. Install OTel packages and create a bootstrap file. Key constraints:
   - Next.js: use @vercel/otel (NOT sdk-node — webpack can't bundle grpc). Create instrumentation.ts with registerOTel(). Write env to .env.local.
   - Node.js server (Hono/Express/etc): use @opentelemetry/sdk-node with HTTP exporters only. Create tracing.ts, prepend --import ./tracing.ts to the dev/start script, write env to .env.superlog.
   - Vite/React: use @opentelemetry/sdk-trace-web + OTLPTraceExporter (HTTP). Create src/instrumentation.ts, import it first in src/main.tsx, write env to .env.local.
   - Always suppress install output: run installs with > /dev/null 2>&1; echo "exit:$?"
   - Env vars: OTEL_EXPORTER_OTLP_ENDPOINT=${input.region}, OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer ${input.ingestKey}, OTEL_SERVICE_NAME=<package.json name>
3. Add custom spans around 3–5 critical business operations using trace.getTracer() from @opentelemetry/api. Use "domain.verb" naming. Record exceptions and set SpanStatusCode.ERROR on failure. Skip trivial helpers and anything already covered by auto-instrumentation.
4. Start the dev server, verify it loads cleanly, send a test span to ${input.region}/v1/traces. Kill the server.
5. Output exactly one JSON line: {"service":"<name>","signals":["traces","logs","metrics"],"status":"done|partial","reason":"<if partial>"}
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

  return `Use the canonical OpenTelemetry SDK for this runtime/framework. Put the bootstrap at the path the framework expects. Read OTLP endpoint + headers from process.env (or the equivalent); never embed the ingest key in source. Verify by running the project's own dev/start command (or invoking the CLI once) and checking that startup is clean — standalone test scripts miss bundler and transitive-dep issues.`;
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
