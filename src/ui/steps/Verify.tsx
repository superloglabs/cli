import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import path from "node:path";
import React, { useEffect, useRef, useState } from "react";
import type { AgentReport } from "../../agent/prompt.js";
import type { Detection } from "../../detect.js";
import { Colors, Icons } from "../theme.js";

type Signals = {
  traces: { count: number; firstAt?: string; firstSpanName?: string };
  logs: { count: number };
  metrics: { count: number };
};

type Props = {
  cwd: string;
  gatewayUrl: string;
  token: string;
  startedAt: string;
  /** What the install agent said it configured. If present, we trust the
   *  agent's service name over the local heuristic. */
  report?: AgentReport;
  /** Detection result — used to reframe messaging for event-driven runtimes
   *  (AppleScript) where real telemetry only flows when triggers fire. */
  detection?: Detection;
  onComplete: () => void;
  onPartial: (reason: string) => void;
};

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 45_000;

export const VerifyStep: React.FC<Props> = ({
  cwd,
  gatewayUrl,
  token,
  startedAt,
  report,
  detection,
  onComplete,
  onPartial,
}) => {
  const [signals, setSignals] = useState<Signals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const service = report?.service ?? deriveServiceName(cwd);
  const isEventDriven = detection?.runtime === "applescript";

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const deadline = Date.now() + TIMEOUT_MS;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const url = new URL("/v1/telemetry/recent", gatewayUrl);
        url.searchParams.set("service", service);
        url.searchParams.set("since", startedAt);
        const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) {
          if (Date.now() > deadline) {
            onPartial(`telemetry query returned ${r.status}`);
            return;
          }
          setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        const data = (await r.json()) as Signals;
        setSignals(data);
        if (data.traces.count > 0 || data.logs.count > 0 || data.metrics.count > 0) {
          onComplete();
          return;
        }
        if (Date.now() > deadline) {
          onPartial(
            isEventDriven
              ? `no install-test event from "${service}" landed within ${TIMEOUT_MS / 1000}s — the on-host agent may not be installed yet. Run \`superlog agent install\` and then \`superlog agent status\` to confirm.`
              : `no spans from service "${service}" landed within ${TIMEOUT_MS / 1000}s`,
          );
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (Date.now() > deadline) {
          setError(msg);
          onPartial(`telemetry query failed: ${msg}`);
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
    };
  }, [gatewayUrl, token, service, startedAt, onComplete, onPartial]);

  if (error) {
    return (
      <Text color={Colors.error}>
        {Icons.cross} {error}
      </Text>
    );
  }

  const spinnerLabel = isEventDriven
    ? `Waiting for install-test event from "${service}" (scripts are event-driven — real events land when triggers fire)…`
    : `Waiting for telemetry from service "${service}"…`;

  if (!signals) {
    return <Spinner label={spinnerLabel} />;
  }

  return (
    <Box flexDirection="column">
      <Spinner label={spinnerLabel} />
      <Box flexDirection="column" marginTop={1}>
        <Text color={Colors.muted}>
          {`  ${Icons.dot} `}Traces: {signals.traces.count}
          {signals.traces.firstSpanName ? ` (first: ${signals.traces.firstSpanName})` : ""}
        </Text>
        <Text color={Colors.muted}>
          {`  ${Icons.dot} `}Logs: {signals.logs.count}
        </Text>
        <Text color={Colors.muted}>
          {`  ${Icons.dot} `}Metrics: {signals.metrics.count}
        </Text>
      </Box>
    </Box>
  );
};

function deriveServiceName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")) as {
      name?: string;
    };
    if (pkg.name && typeof pkg.name === "string") {
      // Trim npm scope (e.g., "@superlog/sample" → "sample") — matches what
      // most OTel exporters end up tagging when serviceName falls back to
      // pkg.name and scopes are stripped by the runtime.
      const withoutScope = pkg.name.replace(/^@[^/]+\//, "");
      return withoutScope;
    }
  } catch {
    // fall through
  }
  return path.basename(cwd);
}
