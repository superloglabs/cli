# LiveKit Server SDK — `livekit-server-sdk`

This is the thin REST/JWT client used to mint access tokens and call LiveKit's `RoomService` from your backend. It has no streaming runtime, so the base framework's HTTP auto-instrumentation already covers most of the surface area (incoming requests that issue tokens get spanned automatically).

Targeted manual spans worth adding — wrap each `RoomServiceClient` method the project actually calls:

  import { trace, SpanStatusCode } from "@opentelemetry/api";
  const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? "<service-name>");

  async function endRoom(roomName: string) {
    return tracer.startActiveSpan("livekit.room_service.deleteRoom", async (span) => {
      try {
        span.setAttributes({ "livekit.room": roomName });
        await roomService.deleteRoom(roomName);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

Method names worth wrapping (only the ones the codebase actually calls — don't add spans for unused surface): `createRoom`, `deleteRoom`, `listRooms`, `listParticipants`, `removeParticipant`, `mutePublishedTrack`, `updateParticipant`, `sendData`, `updateRoomMetadata`. Likewise for `EgressClient`, `IngressClient`, `SipClient` if used.

Span attribute conventions: `livekit.room`, `livekit.participant.identity`, `livekit.track.sid` where applicable.

Skip: `AccessToken.toJwt()` — pure local JWT signing, no I/O, no value in spanning. The HTTP route that issues the token is already auto-instrumented.
