import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { openBrowser, pollDeviceToken, startDevice } from "../../auth/device.js";
import { type StoredAuth, loadAuth, saveAuth } from "../../auth/store.js";
import { Colors, Icons } from "../theme.js";

type Props = {
  gatewayUrl: string;
  onComplete: (auth: StoredAuth) => void;
  onFail: (reason: string) => void;
};

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; userCode: string; url: string }
  | { kind: "error"; message: string };

export const AuthStep: React.FC<Props> = ({ gatewayUrl, onComplete, onFail }) => {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const cached = loadAuth();
    if (cached && cached.gatewayUrl === gatewayUrl) {
      onComplete(cached);
      return;
    }

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
  }, [gatewayUrl, onComplete, onFail]);

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
