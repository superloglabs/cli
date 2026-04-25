import type { AgentRecap, AgentReport } from "../agent/prompt.js";
import type { Detection } from "../detect.js";

export type StepId = "detect" | "auth" | "agent" | "verify";

export const STEP_ORDER: StepId[] = ["detect", "auth", "agent", "verify"];

export const STEP_LABELS: Record<StepId, string> = {
  detect: "Detect project",
  auth: "Authenticate",
  agent: "Instrument & verify",
  verify: "Confirm telemetry",
};

export type WizardState = {
  cwd: string;
  step: StepId | "done" | "partial" | "failed";
  /** ISO timestamp of wizard start — used as the "since" lower bound when
   *  polling for telemetry in the Verify step. */
  startedAt: string;
  detection?: Detection;
  region?: string;
  token?: string;
  ingestKey?: string;
  projectId?: string;
  gatewayUrl?: string;
  user?: string;
  org?: string;
  failure?: string;
  warning?: string;
  /** What the install agent reported it configured — service name + signals.
   *  The Verify step uses this to query for real telemetry. */
  report?: AgentReport;
  /** Free-form summary of changes the agent made — shown on the done/partial screens. */
  recap?: AgentRecap;
};

export function nextStep(current: StepId): StepId | "done" {
  const i = STEP_ORDER.indexOf(current);
  return i === STEP_ORDER.length - 1 ? "done" : (STEP_ORDER[i + 1] as StepId);
}
