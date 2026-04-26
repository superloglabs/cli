# Temporal worker — `@temporalio/interceptors-opentelemetry`

This project runs a Temporal Worker. Temporal's Node SDK ships an official OTel integration that wires interceptors across client + worker + workflow + activity in one shot.

Install:
  @temporalio/interceptors-opentelemetry

Wire it via the `OpenTelemetryPlugin` on `Worker.create`. Reuse the `Resource` and `SpanProcessor` from the base SDK bootstrap rather than constructing new ones — the plugin owns its own `TracerProvider` internally for workflow-isolate replay safety, but it needs the resource + processor to push spans through your existing exporter.

  import { Worker } from "@temporalio/worker";
  import { OpenTelemetryPlugin } from "@temporalio/interceptors-opentelemetry";

  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: "<existing-queue>",
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

If the project also constructs a Temporal `Client` (for starting workflows from an HTTP route), pass the SAME plugin instance there too:

  import { Client, Connection } from "@temporalio/client";

  const client = new Client({
    connection: await Connection.connect(),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

Critical workflow-bundle gotcha: workflow code runs in an isolated v8 context that cannot import your normal OTel SDK. The plugin handles this by injecting a workflow-side interceptor module into the workflow bundle — but ONLY if the bundle picks up its plugin config. If the project pre-bundles workflows via `bundleWorkflowCode(...)` (rather than letting `Worker.create` bundle from `workflowsPath`), you MUST pass the same `plugins` array there too:

  await bundleWorkflowCode({
    workflowsPath: require.resolve("./workflows"),
    plugins: [new OpenTelemetryPlugin({ resource, spanProcessor })],
  });

Without that, workflow tracing silently breaks — workflows run, spans just never appear. Grep for `bundleWorkflowCode` before declaring success; if found, the plugins arg must be present.

Span names follow `StartWorkflow:<WorkflowName>`, `RunWorkflow:<WorkflowName>`, `RunActivity:<ActivityName>` — no naming work needed. Skip wrapping individual activities/workflows in your own custom spans; the interceptor already covers them. Custom spans should target business operations INSIDE activities (the activity span becomes the parent automatically).

Caveats:
- `OpenTelemetryPlugin` is marked `@experimental` in the SDK. The official `samples-typescript/interceptors-opentelemetry` repo uses it, so it's the canonical path despite the marker.
- The plugin handles spans only. Temporal's Rust core metrics ship through `Runtime.install({ telemetryOptions: ... })` — separate concern, leave alone unless the user asks for it.
- Workflow code uses W3C trace propagation by default. If the host app uses a non-W3C propagator (Jaeger, B3), register a `CompositePropagator` at the top of the workflow file too.
