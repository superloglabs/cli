import { ConfirmInput, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { type Detection, detect } from "../../detect.js";
import { Colors } from "../theme.js";

type Props = { cwd: string; onComplete: (d: Detection) => void };

export const DetectStep: React.FC<Props> = ({ cwd, onComplete }) => {
  const [detection, setDetection] = useState<Detection | null>(null);
  const autoConfirm = process.env.SUPERLOG_AUTO_CONFIRM === "1";

  useEffect(() => {
    detect(cwd).then(setDetection);
  }, [cwd]);

  useEffect(() => {
    if (detection && autoConfirm) {
      onComplete(detection);
    }
  }, [detection, autoConfirm, onComplete]);

  if (!detection) {
    return <Spinner label="Detecting runtime and framework…" />;
  }

  const label =
    detection.runtime === "unknown"
      ? "Couldn't detect a runtime — continue anyway?"
      : `Detected ${detection.runtime}${
          detection.framework !== "plain" ? ` (${detection.framework})` : ""
        }. Does that look right?`;

  if (autoConfirm) {
    return <Text>{label} (auto-confirmed via SUPERLOG_AUTO_CONFIRM)</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box>
        <Text color={Colors.muted}>(y/n) </Text>
        <ConfirmInput
          onConfirm={() => onComplete(detection)}
          onCancel={() => process.exit(0)}
        />
      </Box>
    </Box>
  );
};
