import { render } from "ink";
import React from "react";
import { type AgentTask, runAgent } from "../agent/runner.js";
import { loadAuth } from "../auth/store.js";
import { detect } from "../detect.js";
import { App } from "../ui/App.js";

export async function runInit(args: { cwd: string }): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App, { cwd: args.cwd }));
  await waitUntilExit();
}

export type NonInteractiveOptions = {
  cwd: string;
  token?: string;
  ingestKey?: string;
  gatewayUrl?: string;
  region?: string;
};

export async function runInitNonInteractive(args: NonInteractiveOptions): Promise<void> {
  const DEFAULT_GATEWAY_URL = process.env.SUPERLOG_GATEWAY_URL ?? "https://api.superlog.sh";
  const DEFAULT_INGEST_URL = process.env.SUPERLOG_INGEST_URL ?? "https://intake.superlog.sh";

  const cached = loadAuth();
  const token = args.token ?? process.env.SUPERLOG_TOKEN ?? cached?.token;
  const ingestKey = args.ingestKey ?? process.env.SUPERLOG_INGEST_KEY ?? cached?.ingestKey;
  const gatewayUrl = args.gatewayUrl ?? process.env.SUPERLOG_GATEWAY_URL ?? cached?.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const region = args.region ?? process.env.SUPERLOG_INGEST_URL ?? DEFAULT_INGEST_URL;

  if (!token) {
    console.error("error: --token required in non-interactive mode (or log in interactively first)");
    process.exitCode = 1;
    return;
  }
  if (!ingestKey) {
    console.error("error: --ingest-key required in non-interactive mode (or log in interactively first)");
    process.exitCode = 1;
    return;
  }

  const detection = await detect(args.cwd);
  console.log(`detect  ${detection.runtime}/${detection.framework}  (${detection.packageManager})`);

  let failed = false;
  const taskList: (AgentTask & { done: boolean })[] = [];

  await runAgent({
    input: { cwd: args.cwd, detection, region, token, ingestKey, gatewayUrl },
    onEvent: (event) => {
      switch (event.kind) {
        case "status":
          console.log(`status  ${event.message}`);
          break;
        case "tasks":
          for (const t of event.tasks) taskList.push({ ...t, done: false });
          console.log("\ntasks:");
          for (const t of taskList) {
            console.log(`  ○  ${t.path.padEnd(24)} ${t.framework}`);
          }
          console.log();
          break;
        case "task-done": {
          const t = taskList.find((t) => t.path === event.path);
          if (t) t.done = true;
          const remaining = taskList.filter((t) => !t.done).map((t) => t.path);
          const suffix = remaining.length ? `  (${remaining.length} remaining)` : "";
          console.log(`✔  ${event.path}${suffix}`);
          break;
        }
        case "tool":
          console.log(`tool    ${event.name}  ${event.summary}`);
          break;
        case "text":
          // suppress raw agent prose in non-interactive output
          break;
        case "report":
          console.log(`report  ${JSON.stringify(event.report)}`);
          break;
        case "done":
          console.log("done");
          break;
        case "partial":
          console.log(`partial  ${event.reason}`);
          break;
        case "abort":
          console.error(`abort  ${event.reason}`);
          failed = true;
          break;
        case "error":
          console.error(`error  ${event.message}`);
          failed = true;
          break;
      }
    },
  });

  if (failed) process.exitCode = 1;
}
