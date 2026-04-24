import { Box, Text, useApp } from "ink";
import React, { useEffect, useState } from "react";
import type { StoredAuth } from "../auth/store.js";
import type { Detection } from "../detect.js";
import { StepList } from "./StepList.js";
import { AgentStep } from "./steps/Agent.js";
import { AuthStep } from "./steps/Auth.js";
import { DetectStep } from "./steps/Detect.js";
import { VerifyStep } from "./steps/Verify.js";
import { type StepId, type WizardState, nextStep } from "./steps.js";
import { Colors, Icons } from "./theme.js";

type Props = { cwd: string };

const DEFAULT_GATEWAY_URL = process.env.SUPERLOG_GATEWAY_URL ?? "https://api.superlog.sh";
const DEFAULT_INGEST_URL = process.env.SUPERLOG_INGEST_URL ?? "https://intake.superlog.sh";

export const App: React.FC<Props> = ({ cwd }) => {
  const { exit } = useApp();
  const [state, setState] = useState<WizardState>({
    cwd,
    step: "detect",
    startedAt: new Date().toISOString(),
    gatewayUrl: DEFAULT_GATEWAY_URL,
    region: DEFAULT_INGEST_URL,
  });

  useEffect(() => {
    if (state.step === "done" || state.step === "partial" || state.step === "failed") {
      const t = setTimeout(exit, 500);
      return () => clearTimeout(t);
    }
  }, [state.step, exit]);

  const advance = (patch: Partial<WizardState>) => {
    setState((s) => {
      if (s.step === "done" || s.step === "partial" || s.step === "failed") return s;
      return { ...s, ...patch, step: nextStep(s.step as StepId) };
    });
  };

  const fail = (reason: string) => {
    setState((s) => ({ ...s, step: "failed", failure: reason }));
  };

  const partial = (reason: string) => {
    setState((s) => ({ ...s, step: "partial", warning: reason }));
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color={Colors.accent}>■ </Text>
        <Text bold color={Colors.fg}>
          superlog
        </Text>
        <Text color={Colors.muted}>  help agents fix themselves</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.subtle}>{"─".repeat(44)}</Text>
      </Box>

      <StepList state={state} />

      <Box marginTop={1}>
        {state.step === "detect" && (
          <DetectStep cwd={state.cwd} onComplete={(d: Detection) => advance({ detection: d })} />
        )}
        {state.step === "auth" && state.gatewayUrl && (
          <AuthStep
            gatewayUrl={state.gatewayUrl}
            onComplete={(auth: StoredAuth) =>
              advance({
                token: auth.token,
                ingestKey: auth.ingestKey,
                projectId: auth.projectId,
                gatewayUrl: auth.gatewayUrl,
                user: auth.user,
                org: auth.org,
              })
            }
            onFail={fail}
          />
        )}
        {state.step === "agent" &&
          state.detection &&
          state.region &&
          state.token &&
          state.ingestKey &&
          state.gatewayUrl && (
            <AgentStep
              cwd={state.cwd}
              detection={state.detection}
              region={state.region}
              token={state.token}
              ingestKey={state.ingestKey}
              gatewayUrl={state.gatewayUrl}
              onReport={(report) => setState((s) => ({ ...s, report }))}
              onComplete={() => advance({})}
              onPartial={partial}
              onFail={fail}
            />
          )}
        {state.step === "verify" && state.gatewayUrl && state.token && (
          <VerifyStep
            cwd={state.cwd}
            gatewayUrl={state.gatewayUrl}
            token={state.token}
            startedAt={state.startedAt}
            report={state.report}
            detection={state.detection}
            onComplete={() => advance({})}
            onPartial={partial}
          />
        )}
        {state.step === "done" && (
          <Text color={Colors.success}>
            {Icons.check} You're wired up. Errors in → fixes out.
          </Text>
        )}
        {state.step === "partial" && (
          <Box flexDirection="column">
            <Text color={Colors.accent}>
              {Icons.warning} Instrumented, but couldn't verify ingest: {state.warning}
            </Text>
            <Text color={Colors.muted}>
              Your project is configured. Spans will flow once ingest is reachable.
            </Text>
          </Box>
        )}
        {state.step === "failed" && (
          <Box flexDirection="column">
            <Text color={Colors.error}>
              {Icons.cross} Install aborted: {state.failure}
            </Text>
            <Text color={Colors.muted}>Logs may have more detail. Re-run after fixing.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
