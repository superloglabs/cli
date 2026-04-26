# Vite / React (browser)

Use `@opentelemetry/sdk-trace-web` with the OTLP HTTP exporter. Metrics are not covered (browser metrics SDK is not stable). Vite exposes env vars to the browser only when prefixed with `VITE_`.

Install:
  @opentelemetry/sdk-trace-web
  @opentelemetry/sdk-trace-base
  @opentelemetry/exporter-trace-otlp-http
  @opentelemetry/instrumentation-fetch
  @opentelemetry/instrumentation
  @opentelemetry/resources
  @opentelemetry/semantic-conventions
  @opentelemetry/api

Create `src/instrumentation.ts`:

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
            url: `${endpoint}/v1/traces`,
            headers: { authorization: `Bearer ${ingestKey}` },
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

Add `import "./instrumentation"` as the very first line of the Vite entry file (typically `src/main.tsx` or `src/main.ts`) — before React, before any other imports.

Write env to `.env.local` at the project root (Vite auto-loads it and gitignores it by default):

  VITE_OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint>
  VITE_SUPERLOG_INGEST_KEY=<the ingest API key>
  VITE_OTEL_SERVICE_NAME=<the "name" field from package.json>

Important caveats:

1. CORS — the browser sends a preflight OPTIONS request before each OTLP POST. The Superlog endpoint must return Access-Control-Allow-Origin and Access-Control-Allow-Headers (authorization, content-type) for the app's origin. Verify before claiming success:
     curl -s -o /dev/null -w "%{http_code}" -X OPTIONS <endpoint>/v1/traces \
       -H "Origin: http://localhost:5173" \
       -H "Access-Control-Request-Headers: authorization,content-type"
   A 2xx with CORS headers = OK. Absent or 4xx = report partial success with reason "OTLP endpoint does not allow browser-origin requests; CORS must be enabled on the collector".

2. Ingest key in bundle — VITE_SUPERLOG_INGEST_KEY will be included in the compiled JS bundle and visible to anyone who loads the page. This is intentional: the ingest key is project-scoped and write-only (it cannot read data). Still, commit it only to `.env.local`, never hardcode it in source.

Signals: traces only.
