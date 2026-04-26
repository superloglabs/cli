# Next.js

Use `@vercel/otel`, NOT `@opentelemetry/sdk-node`. sdk-node transitively pulls in `@grpc/grpc-js`, which webpack cannot bundle (fails with "Module not found: Can't resolve 'stream'"). @vercel/otel is Vercel's maintained wrapper that handles Next.js's runtime split and OTel 2.x API changes.

Install: `@vercel/otel` and `@opentelemetry/api`. Nothing else — @vercel/otel brings its own exporters.

Create `instrumentation.ts` at the project root:

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

Write env to `.env.local` at the project root (Next.js auto-loads it; do NOT write to `.env.superlog` unless .env.local already exists and you need to avoid clobbering it):

  OTEL_EXPORTER_OTLP_ENDPOINT=<the Superlog OTLP endpoint>
  OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest API key>
  OTEL_SERVICE_NAME=<the "name" field from package.json>

@vercel/otel picks up OTEL_EXPORTER_OTLP_* automatically. Never put the key in instrumentation.ts.

Verify by running the project's dev command (check the "dev" script in package.json), waiting for Next.js to log "Ready" / "Local:", and hitting one route with curl. Watch for errors like "Resource is not a constructor" or "Module not found" — those mean the instrumentation file is wrong.
