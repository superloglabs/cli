import type { Detection } from "../detect.js";

export const AGENT_MARKERS = {
  status: "[SUPERLOG-STATUS]",
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
5. Before printing \`${AGENT_MARKERS.done}\` or \`${AGENT_MARKERS.partial}\`, emit exactly one report line:

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

Rules:
- Never modify files outside the project root.
- Never commit to git, never push, never open PRs.
- Prefer idempotent writes — if a config file already exists, edit rather than overwrite.
- Match the existing style: TypeScript if the project is TS, plain JS if JS.
- Do not install heavy unrelated dependencies.
- Use the project's existing package manager (detected via lockfile).`;
}

export function buildTaskPrompt(input: AgentInput): string {
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

Framework recipe:
${recipeFor(input.detection)}

Verification:
1. Run the project's own dev or build command and confirm it completes without errors from the OTel code. For a web framework, start the dev server, wait for it to report ready, and hit a route with curl so traffic flows through your instrumentation. Kill the server when done.
2. As a fallback check that ingest is reachable, POST a tiny OTLP span JSON to ${input.region}/v1/traces with \`authorization: Bearer ${input.ingestKey}\`. A 2xx confirms ingest; a 401/403/400 means ${AGENT_MARKERS.abort}; DNS/timeout/5xx means ${AGENT_MARKERS.partial}.

Print one terminal marker per the system prompt contract based on the combined outcome.`;
}

function recipeFor(detection: Detection): string {
  if (detection.runtime === "applescript") {
    return appleScriptRecipe();
  }

  if (detection.framework === "next") {
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

  return `Use the canonical OpenTelemetry SDK for this runtime/framework. Put the bootstrap at the path the framework expects. Read OTLP endpoint + headers from process.env (or the equivalent); never embed the ingest key in source. Verify by running the project's own dev/start command (or invoking the CLI once) and checking that startup is clean — standalone test scripts miss bundler and transitive-dep issues.`;
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
