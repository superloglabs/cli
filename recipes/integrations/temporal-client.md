# Temporal client — `@temporalio/interceptors-opentelemetry`

This project uses Temporal as a client only (starting workflows from HTTP routes or background jobs — no `Worker.create` here). Wire the OTel plugin onto the `Client` so trace context propagates from the calling request into the workflow.

Install:
  @temporalio/interceptors-opentelemetry

Wire `OpenTelemetryPlugin` on the existing `Client` construction, reusing the `Resource` and `SpanProcessor` from the base SDK bootstrap:

  import { Client, Connection } from "@temporalio/client";
  import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";

  const client = new Client({
    connection: await Connection.connect(),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

That's the whole client-side recipe. Workflow execution traces are produced by whatever Worker is on the other end — if the worker isn't also instrumented, you'll only see the client-side `StartWorkflow:<Name>` span linking out, then a gap. That's expected and worth telling the user in the recap if you can detect that the worker is in a different repo.

Caveat: the plugin is marked `@experimental` in the SDK source. It IS the canonical path per the official samples — just flag it if asked.
