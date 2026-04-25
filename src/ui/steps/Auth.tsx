import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { openBrowser, pollDeviceToken, startDevice } from "../../auth/device.js";
import { type StoredAuth, clearAuth, loadAuth, saveAuth } from "../../auth/store.js";
import { Colors, Icons } from "../theme.js";

type Props = {
  gatewayUrl: string;
  onComplete: (auth: StoredAuth) => void;
  onFail: (reason: string) => void;
};

const CONFIRM_SECONDS = 3;

type Phase =
  | { kind: "confirm"; cached: StoredAuth; secondsLeft: number }
  | { kind: "starting" }
  | { kind: "waiting"; userCode: string; url: string }
  | { kind: "error"; message: string };

export const AuthStep: React.FC<Props> = ({ gatewayUrl, onComplete, onFail }) => {
  const cached = loadAuth();
  const hasUsableCache = cached !== null && cached.gatewayUrl === gatewayUrl;
  const [phase, setPhase] = useState<Phase>(
    hasUsableCache
      ? { kind: "confirm", cached: cached as StoredAuth, secondsLeft: CONFIRM_SECONDS }
      : { kind: "starting" },
  );
  const deviceStartedRef = useRef(false);

  // Countdown for the confirm phase — auto-accept cached creds when it hits 0.
  useEffect(() => {
    if (phase.kind !== "confirm") return;
    if (phase.secondsLeft <= 0) {
      onComplete(phase.cached);
      return;
    }
    const t = setTimeout(() => {
      setPhase((p) =>
        p.kind === "confirm" ? { ...p, secondsLeft: p.secondsLeft - 1 } : p,
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [phase, onComplete]);

  useInput(
    (input) => {
      if (phase.kind !== "confirm") return;
      if (input === "r" || input === "R") {
        clearAuth();
        setPhase({ kind: "starting" });
      } else {
        onComplete(phase.cached);
      }
    },
    { isActive: phase.kind === "confirm" },
  );

  // Device flow — runs once when we enter `starting` (either no cache or user pressed R).
  useEffect(() => {
    if (phase.kind !== "starting") return;
    if (deviceStartedRef.current) return;
    deviceStartedRef.current = true;

    (async () => {
      try {
        const device = await startDevice(gatewayUrl);
        openBrowser(device.verification_uri_complete);
        setPhase({
          kind: "waiting",
          userCode: device.user_code,
          url: device.verification_uri_complete,
        });
        const tok = await pollDeviceToken(gatewayUrl, device.device_code, {
          intervalSec: device.interval,
          timeoutMs: device.expires_in * 1000,
        });
        const auth: StoredAuth = {
          token: tok.access_token,
          ingestKey: tok.ingest_key,
          projectId: tok.project_id,
          gatewayUrl: tok.gateway_url,
          user: tok.user,
          org: tok.org,
        };
        saveAuth(auth);
        onComplete(auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setPhase({ kind: "error", message: msg });
        onFail(msg);
      }
    })();
  }, [phase.kind, gatewayUrl, onComplete, onFail]);

  if (phase.kind === "confirm") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={Colors.success}>{Icons.check} </Text>
          <Text>Signed in as </Text>
          <Text bold color={Colors.fg}>
            {phase.cached.user}
          </Text>
          <Text color={Colors.muted}> ({phase.cached.org})</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={Colors.muted}>
            press <Text color={Colors.accent}>R</Text> to switch account, anything else to
            continue ({phase.secondsLeft}s)
          </Text>
        </Box>
      </Box>
    );
  }
  if (phase.kind === "starting") {
    return <Spinner label="Requesting device code…" />;
  }
  if (phase.kind === "error") {
    return (
      <Text color={Colors.error}>
        {Icons.cross} Auth failed: {phase.message}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>Open this URL to sign in (we tried to launch it for you):</Text>
      <Box marginTop={1}>
        <Text color={Colors.primary}>{phase.url}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Code: </Text>
        <Text bold color={Colors.accent}>
          {phase.userCode}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Spinner label="Waiting for approval…" />
      </Box>
    </Box>
  );
};
