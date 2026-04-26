# LiveKit Client (browser) — `livekit-client`

This project uses the LiveKit browser SDK to join rooms and publish tracks. The base browser recipe already wires fetch instrumentation; layer LiveKit-specific spans for the room lifecycle on top.

Wrap these methods directly with spans (use the existing browser tracer from the base recipe):

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  import { Room, RoomEvent, DisconnectReason } from "livekit-client";

  const tracer = trace.getTracer(import.meta.env.VITE_OTEL_SERVICE_NAME ?? "<service-name>");

  async function joinRoom(url: string, token: string) {
    return tracer.startActiveSpan("livekit.room.connect", async (span) => {
      try {
        const room = new Room();
        await room.connect(url, token);
        span.setAttributes({
          "livekit.room": room.name,
          "livekit.participant.identity": room.localParticipant.identity,
        });
        return room;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

Wrap likewise: `room.localParticipant.publishTrack` → `livekit.track.publish`, `room.localParticipant.unpublishTrack` → `livekit.track.unpublish`, `room.disconnect()` → `livekit.room.disconnect`.

For passive lifecycle events (the user didn't initiate them), subscribe to `RoomEvent` and either start short child spans or add events to the active span:

  room.on(RoomEvent.Reconnecting, () => activeSpan?.addEvent("livekit.reconnecting"));
  room.on(RoomEvent.Reconnected, () => activeSpan?.addEvent("livekit.reconnected"));
  room.on(RoomEvent.Disconnected, (reason: DisconnectReason) => {
    activeSpan?.setAttributes({ "livekit.disconnect.reason": DisconnectReason[reason] });
  });

Span attribute conventions: `livekit.room`, `livekit.participant.identity`, `livekit.track.sid`, `livekit.track.source`, `livekit.track.kind`.

CORS reminder: same caveat as the base browser recipe — the OTLP endpoint must allow the app's origin. Already covered by the verification step there.
