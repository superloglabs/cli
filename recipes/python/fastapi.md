# FastAPI (Python)

Use `opentelemetry-instrumentation-fastapi` driven by the `opentelemetry-instrument` CLI wrapper. Do NOT use the gRPC OTLP exporter (`opentelemetry-exporter-otlp-proto-grpc`); it pulls in `grpcio` with native wheels that complicate Docker/CI builds. The HTTP/protobuf exporter is pure-Python and ingests at the same OTLP endpoint.

Install (use the project's package manager — `pip install` for requirements.txt projects, `poetry add` for pyproject.toml/poetry, `uv add` for uv-managed projects):
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

Skip DB/cache instrumentations the project doesn't actually depend on — check the manifest first. Suppress install output: append `> /dev/null 2>&1; echo "exit:$?"`.

Bootstrap — preferred path is the `opentelemetry-instrument` CLI wrapper. Identify how the project starts uvicorn / hypercorn / fastapi-cli (check pyproject scripts, Procfile, Dockerfile CMD, README, or a shell script in the repo root). Prepend `opentelemetry-instrument` to that command. Examples:

  uvicorn app.main:app --host 0.0.0.0 --port 8000
  → opentelemetry-instrument uvicorn app.main:app --host 0.0.0.0 --port 8000

  fastapi run app/main.py
  → opentelemetry-instrument fastapi run app/main.py

  python -m app
  → opentelemetry-instrument python -m app

If the project has a `scripts` entry in pyproject.toml ([tool.poetry.scripts] or [project.scripts]) that wraps the start command, edit that script's invocation rather than every call site. If the project starts via `if __name__ == "__main__": uvicorn.run(...)`, the CLI wrapper still works — wrap `python <entry>.py`.

Fallback path (only if the start command can't be wrapped — e.g. the project embeds uvicorn.run() inside a function called from elsewhere): create a `tracing.py` module at the project root and import it as the very first line of the entry module, before `from fastapi import FastAPI`:

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
          "Superlog env vars missing — load .env.superlog before starting (e.g. `set -a; source .env.superlog; set +a`)."
      )

  resource = Resource.create({"service.name": os.getenv("OTEL_SERVICE_NAME", "<derive-from-pyproject>")})
  provider = TracerProvider(resource=resource)
  provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
  trace.set_tracer_provider(provider)

  LoggingInstrumentor().instrument(set_logging_format=True)
  RequestsInstrumentor().instrument()
  # FastAPIInstrumentor.instrument_app(app) is called from main.py after `app = FastAPI(...)`

Then in the entry module:

  import tracing  # noqa: F401  -- must be first, before any framework imports
  from fastapi import FastAPI
  from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

  app = FastAPI()
  FastAPIInstrumentor.instrument_app(app)

Prefer the CLI wrapper. The fallback exists because some projects can't be wrapped cleanly (e.g. embedded uvicorn invocations behind a custom CLI).

Env vars — write to `.env.superlog` at the project root (FastAPI projects don't auto-load .env unless they use python-dotenv or pydantic-settings; check the project before assuming). Always set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` — the Python OTLP SDK defaults to gRPC and will fail to export over the HTTP-only Superlog endpoint without it.

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key>
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  OTEL_SERVICE_NAME=<the project name from pyproject.toml [project] or [tool.poetry], or the repo dir name>
  OTEL_PYTHON_LOG_CORRELATION=true
  OTEL_LOGS_EXPORTER=otlp
  OTEL_METRICS_EXPORTER=otlp
  OTEL_TRACES_EXPORTER=otlp

If the project already loads a .env via python-dotenv or pydantic-settings, append these to that .env instead of creating .env.superlog. Never embed the ingest key as a literal in source.

Custom spans — use the standard `opentelemetry.trace` API:

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

Verification — start the app the way the project normally starts it (with the wrapper applied), wait for uvicorn to log "Application startup complete", and curl one route. Watch for "Failed to export" / "Connection refused" / "Transient error" in the OTel logs — those indicate the HTTP endpoint or auth header is wrong. Kill the server when done. Then POST a small OTLP test span to <endpoint>/v1/traces with `authorization: Bearer <key>` as a fallback ingest sanity check.

Signals: traces + logs + metrics (the distro wires all three when the OTEL_*_EXPORTER vars are set).
