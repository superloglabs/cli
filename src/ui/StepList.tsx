import { Box, Text } from "ink";
import React from "react";
import { STEP_LABELS, STEP_ORDER, type StepId, type WizardState } from "./steps.js";
import { Colors, Icons } from "./theme.js";

export const StepList: React.FC<{ state: WizardState }> = ({ state }) => {
  const currentIdx =
    state.step === "done" || state.step === "partial"
      ? STEP_ORDER.length
      : STEP_ORDER.indexOf(state.step as StepId);

  return (
    <Box flexDirection="column">
      {STEP_ORDER.map((id, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const icon = done ? Icons.check : active ? Icons.active : Icons.pending;
        const color = done ? Colors.success : active ? Colors.primary : Colors.muted;
        const detail = summary(state, id);
        return (
          <Box key={id}>
            <Text color={color}>{icon} </Text>
            <Text color={done ? Colors.muted : color}>{STEP_LABELS[id]}</Text>
            {done && detail && <Text color={Colors.muted}> — {detail}</Text>}
          </Box>
        );
      })}
    </Box>
  );
};

function summary(state: WizardState, id: StepId): string {
  switch (id) {
    case "detect":
      if (!state.detection) return "";
      return `${state.detection.runtime}${
        state.detection.framework !== "plain" ? ` · ${state.detection.framework}` : ""
      }`;
    case "auth":
      if (!state.token) return "";
      return state.user && state.org ? `${state.user} · ${state.org}` : "signed in";
    case "agent":
      return "instrumented";
    case "verify":
      return state.warning ? "no spans yet" : "spans received";
  }
}
