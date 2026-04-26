# Generic / unknown runtime

No vetted Superlog recipe exists for this runtime/framework. Wire it up best-effort using the canonical OpenTelemetry SDK for the language. Investigate the project before installing — check the entry point, dependency manifest, and run scripts so the bootstrap fires before any app code.

Canonical SDKs by runtime (use HTTP/protobuf exporters, never gRPC — gRPC pulls native deps that complicate containers and CI):

- python: `opentelemetry-distro`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-instrumentation` plus the framework-specific instrumentation package (e.g. `opentelemetry-instrumentation-fastapi`, `-django`, `-flask`). Prefer the `opentelemetry-instrument` CLI wrapper on the start command when the project has a single entry binary; otherwise initialize a TracerProvider explicitly at the top of the main module before any framework imports.
- go: `go.opentelemetry.io/otel`, `go.opentelemetry.io/otel/sdk`, `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp` (+ logs/metrics http exporters). Initialize the provider in `main()` before the HTTP server starts; defer `provider.Shutdown()`. Use the framework's contrib instrumentation if present (`otelgin`, `otelecho`, etc).
- unknown: read README and entry point, identify the actual language, then apply the matching list above. If the project has no obvious runtime, abort with reason "could not identify runtime — manual setup required".

Configuration contract (same for every language):
- Read the OTLP endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT` and the auth header from `OTEL_EXPORTER_OTLP_HEADERS` (`authorization=Bearer <key>`). Set `OTEL_SERVICE_NAME` to the project name.
- Never embed the ingest key as a literal in source. Write it to an env file the runtime auto-loads (`.env`, `.env.local`) if one exists, otherwise `.env.superlog` plus a one-line note in the bootstrap comment telling the user how to load it (e.g. `source .env.superlog`, `--env-file`, dotenv).
- Fail closed: if the env vars are missing at startup, raise/panic with a message naming the missing var. Silent no-op installs are worse than a loud failure.

Bootstrap placement:
- Must execute before any framework or app imports. For Python, that means top of `main.py` / `asgi.py` / `wsgi.py` or via `opentelemetry-instrument` on the run command. For Go, top of `main()` before `http.ListenAndServe`. For other runtimes, find the equivalent and use it.
- Prefer editing the existing run/start command over modifying app source when a CLI wrapper exists.

Verification:
- Run the project's own dev/build/start command (whatever package.json / Makefile / pyproject scripts / go run is wired up to). Confirm it starts without errors traceable to the OTel install. A standalone test script is NOT sufficient — bundler, native-dep, and transitive-import failures only surface inside the real runtime.
- Generate one unit of real traffic (hit a route, invoke the CLI, etc).
- Then POST a small OTLP test span to `<endpoint>/v1/traces` with the bearer header as a fallback ingest sanity check.
- Outcomes: clean run + 2xx test span = done; clean run but ingest unreachable = partial success; runtime errors caused by the install = abort.
