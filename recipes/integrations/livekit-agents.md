# LiveKit Agents

LiveKit Agents has different OTel support depending on the language. Check whether this project is the Node (`@livekit/agents`) or Python (`livekit-agents`) flavor before applying.

## Python (`livekit-agents`) — built-in OTel hook

Use `livekit.agents.telemetry.set_tracer_provider` from inside the entrypoint. Once registered, the framework auto-creates spans for the agent session, LLM calls, function tools, and TTS — no manual span work needed for the standard pipeline.

  from livekit.agents import JobContext
  from livekit.agents.telemetry import set_tracer_provider
  from opentelemetry.sdk.trace import TracerProvider
  from opentelemetry.sdk.trace.export import BatchSpanProcessor
  from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

  async def entrypoint(ctx: JobContext):
      provider = TracerProvider()
      provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
      set_tracer_provider(provider, metadata={"livekit.session.id": ctx.room.name})

      ctx.add_shutdown_callback(lambda: provider.force_flush())

      # ... existing AgentSession.start(...) code stays as-is

Critical: `force_flush()` in the shutdown callback is mandatory. Agent jobs are short-lived; without an explicit flush, the BatchSpanProcessor drops the tail spans when the job exits.

The base Python recipe sets up the global `TracerProvider`. Either reuse that provider here (preferred — pass it into `set_tracer_provider` directly) or let this be the registration point and skip the duplicate base setup. Don't construct two providers.

## Node (`@livekit/agents`) — no built-in OTel, manual spans only

`@livekit/agents` does not yet have a tracing module (tracking issue: livekit/agents-js#757). The base Node SDK bootstrap already gives you HTTP/fetch auto-instrumentation, which covers the WebSocket signaling and HTTP API surface. For the agent-specific work, add manual spans at three layers:

1. **Entrypoint** — wrap the body of your `entry` / `entrypoint` function in one root span per session: `livekit.agent.session`. Set attributes for the room name and participant identity.

2. **Function tools** — wrap each tool callback in a child span named `livekit.tool.<toolName>`. Set the args (excluding PII) as attributes.

3. **LLM/STT/TTS adapter calls** — if the project calls into LLM/STT/TTS adapters explicitly (rather than only via the framework's pipeline), wrap those calls in spans named `llm.chat`, `stt.transcribe`, `tts.synthesize`. The framework also fires its own internal events for these — leaving them unspanned is fine if the user prefers minimal instrumentation.

Use the standard `tracer.startActiveSpan` pattern with `span.recordException` + `SpanStatusCode.ERROR` on failure. Don't try to monkeypatch the framework — wait for the official OTel module instead.

Service name: use `<package.json name>-agent` (e.g. `my-app-agent`) to distinguish the agent process from any sibling HTTP service.
