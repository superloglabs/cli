import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Detection, SubFramework } from "../detect.js";

// Recipes live as plain markdown under `recipes/` at the package root so they
// can also be served verbatim from superlog.sh and consumed by BYO agents via
// curl. The CLI loads them from disk at runtime. We walk up from this module's
// location until we find the directory — this works whether the file is at
// `src/agent/prompt.ts` (dev via tsx) or `dist/agent/prompt.js` (after tsc),
// because the build copies `recipes/` next to `dist/` so the layout matches.
const RECIPES_DIR = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "recipes");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("superlog-cli: recipes/ directory not found relative to prompt.ts");
})();

function loadRecipe(relPath: string): string {
  return readFileSync(resolve(RECIPES_DIR, relPath), "utf8").trimEnd();
}

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
--- STEP 3: ADD CUSTOM SPANS, METRICS, AND LOGS ---

Using the operations identified in Step 1, add manual instrumentation on top of the auto-instrumentation. The bootstrap already gives you HTTP in/out, DB queries, and stdlib logs — your job is to add the **business-level** signals that an SRE would want when something looks wrong.

Three signals to add, in order of leverage:

**(a) Custom spans on critical operations.** Get the tracer once at module level and reuse it:

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? "<service-name>");

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

Naming: use "domain.verb" (e.g. "payment.charge", "email.send", "cache.invalidate", "agent.run", "interview.create", "job.<type>").
Attributes: entity IDs (order.id, user.id, workspace.id, tenant.id), counts, key boolean branch outcomes. Never log PII (emails, passwords, tokens, raw request bodies).
What to skip: trivial getters, pure data transforms, internal helpers, anything already covered by auto-instrumentation. Only wrap operations with real latency or meaningful failure modes.

In Python the decorator form is cleaner when attributes can be set at the start of the function — no manual context manager:

  from opentelemetry import trace
  tracer = trace.get_tracer("<service-name>")

  @tracer.start_as_current_span("interview.create")
  async def create_interview(body, user):
      trace.get_current_span().set_attributes({"workspace.id": str(body.workspace_id), "interview.channel": body.channel})
      # ... function body

**(b) Custom metrics for the business funnel and durations.** Spans tell you about individual requests; metrics tell you about rates and distributions. Get a meter once and create instruments at module level:

  import { metrics } from "@opentelemetry/api";
  const meter = metrics.getMeter(process.env.OTEL_SERVICE_NAME ?? "<service-name>");

  // Counters at funnel events
  const ordersCreated = meter.createCounter("orders.created", { description: "Orders placed" });
  const ordersCompleted = meter.createCounter("orders.completed", { description: "Orders that reached fulfilled state" });
  const ordersFailed = meter.createCounter("orders.failed");

  // Histograms for durations and sizes
  const orderProcessMs = meter.createHistogram("order.process_ms", { unit: "ms" });
  const orderItemCount = meter.createHistogram("order.item_count", { unit: "1" });

  // Increment with low-cardinality dimensions only
  ordersCreated.add(1, { "order.channel": channel, "tenant.id": tenantId });
  orderProcessMs.record(elapsedMs, { "order.channel": channel });

What to count: every funnel boundary (created, started, completed, failed, retried), every job kick-off, every retry, every external-API call to a paid provider. What to histogram: any operation with measurable latency, queue depth, batch size. Dimension cardinality must stay low (channel, status, region — never user.id or order.id).

Python equivalent:

  from opentelemetry import metrics
  meter = metrics.get_meter("<service-name>")
  orders_created = meter.create_counter("orders.created")
  order_process_ms = meter.create_histogram("order.process_ms", unit="ms")
  orders_created.add(1, {"order.channel": channel})

**(c) Logs.** If the bootstrap wires up an OTLP log handler (the recipe takes care of this), then every \`logger.info/error/...\` call inside a span automatically carries the span's \`trace_id\` and \`span_id\` in the OTLP record. You don't need to add anything — just keep using the project's existing logger. Do NOT manually add trace IDs to log messages; the bridge handles it.

If you're tempted to log a structured event ("order created", with fields), prefer a counter or a span attribute instead. Use logs for narrative ("starting batch reconcile", "retrying after 3xx") and exceptional events.

For browser/Vite projects, instrument key user interactions:

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

**Reuse what's already measured.** If the project already collects timestamps for some operation (a custom \`LatencyTracker\`, a \`time.perf_counter()\` block, a "[TIMING]" log line), emit a histogram from those existing measurements instead of measuring twice. Both your custom span and the existing log can stay — the span gives you traceability, the histogram gives you aggregates.

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
  // The recipe markdown talks about outcomes in plain prose ("done", "partial",
  // "abort"); the CLI's terminal-marker contract is set in the system prompt,
  // so the agent translates the prose back into the actual markers.
  const recipe = loadRecipe("generic.md");
  return `Detected runtime/framework: ${detection.runtime}/${detection.framework}.

${recipe}`;
}

function nextRecipe(): string {
  return loadRecipe("node/next.md");
}

function nodeRecipe(): string {
  return loadRecipe("node/server.md");
}

function browserRecipe(): string {
  return loadRecipe("node/vite.md");
}

function fastapiRecipe(): string {
  return loadRecipe("python/fastapi.md");
}

function appleScriptRecipe(): string {
  return loadRecipe("applescript.md");
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
  return loadRecipe("integrations/temporal-worker.md");
}

function temporalClientRecipe(): string {
  return loadRecipe("integrations/temporal-client.md");
}

function liveKitAgentsRecipe(): string {
  return loadRecipe("integrations/livekit-agents.md");
}

function liveKitServerRecipe(): string {
  return loadRecipe("integrations/livekit-server.md");
}

function liveKitClientRecipe(): string {
  return loadRecipe("integrations/livekit-client.md");
}
