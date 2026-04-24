import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { AgentReport } from "../../agent/prompt.js";
import { type AgentEvent, runAgent } from "../../agent/runner.js";
import type { Detection } from "../../detect.js";
import { Colors, Icons } from "../theme.js";

type Props = {
  cwd: string;
  detection: Detection;
  region: string;
  token: string;
  ingestKey: string;
  gatewayUrl: string;
  onReport: (report: AgentReport) => void;
  onComplete: () => void;
  onPartial: (reason: string) => void;
  onFail: (reason: string) => void;
};

type ToolLine = { id: number; name: string; summary: string };

const MAX_TOOL_LINES = 5;

export const AgentStep: React.FC<Props> = ({
  cwd,
  detection,
  region,
  token,
  ingestKey,
  gatewayUrl,
  onReport,
  onComplete,
  onPartial,
  onFail,
}) => {
  const [status, setStatus] = useState<string>("Starting install agent…");
  const [tools, setTools] = useState<ToolLine[]>([]);
  const toolIdRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const handleEvent = (ev: AgentEvent) => {
      switch (ev.kind) {
        case "status":
          setStatus(ev.message);
          return;
        case "tool":
          if (!ev.summary) return;
          setTools((prev) => {
            const next = [...prev, { id: toolIdRef.current++, name: ev.name, summary: ev.summary }];
            return next.slice(-MAX_TOOL_LINES);
          });
          return;
        case "report":
          onReport(ev.report);
          return;
        case "done":
          onComplete();
          return;
        case "partial":
          onPartial(ev.reason || "Ingest unreachable");
          return;
        case "abort":
          onFail(ev.reason || "Agent aborted");
          return;
        case "error":
          onFail(ev.message);
          return;
      }
    };

    void runAgent({
      input: { cwd, detection, region, token, ingestKey, gatewayUrl },
      onEvent: handleEvent,
    });
  }, [cwd, detection, region, token, ingestKey, gatewayUrl, onReport, onComplete, onPartial, onFail]);

  return (
    <Box flexDirection="column">
      <Spinner label={status} />
      {tools.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {tools.map((t) => (
            <Box key={t.id}>
              <Text color={Colors.muted}>{`  ${Icons.dot} `}</Text>
              <Text color={Colors.muted}>{t.name}</Text>
              <Text color={Colors.muted}>{t.summary ? `  ${t.summary}` : ""}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
