# Node.js server (Hono / Express / Fastify / NestJS / plain Node)

Use `@opentelemetry/sdk-node` with HTTP-only OTLP exporters. Do NOT use gRPC exporters (`@opentelemetry/exporter-trace-otlp-grpc`) — they pull in `@grpc/grpc-js` with native binaries that complicate containerization and CI.

Install:
  @opentelemetry/sdk-node
  @opentelemetry/auto-instrumentations-node
  @opentelemetry/exporter-trace-otlp-http
  @opentelemetry/exporter-logs-otlp-http
  @opentelemetry/exporter-metrics-otlp-http
  @opentelemetry/sdk-metrics
  @opentelemetry/sdk-logs
  @opentelemetry/api

Create `tracing.ts` at the project root (or `src/tracing.ts` if a `src/` directory exists):

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

Option A (preferred if the project uses tsx or ts-node): prepend `--import ./tracing.ts` to the tsx/ts-node invocation in the dev/start script in package.json. Example:
  "start": "tsx --import ./tracing.ts src/index.ts"
  "dev": "tsx watch --import ./tracing.ts src/index.ts"

Option B (if the entry file is plain JS/TS without a loader flag): add `import "./tracing.js"` as the very first line of the entry file (before any framework or app imports).

Check the existing "dev" and "start" scripts in package.json to decide which option fits. Prefer Option A because it avoids touching application code.

Write env to `.env.superlog` at the project root. If the project already uses dotenv, add `require("dotenv").config({ path: ".env.superlog" })` at the top of tracing.ts (before the env check). If it uses Node 20+ `--env-file`, add `--env-file .env.superlog` to the start script instead.

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key>
  OTEL_SERVICE_NAME=<the "name" field from package.json>

Signals: traces + logs + metrics (NodeSDK wires all three via the explicit exporters above).
