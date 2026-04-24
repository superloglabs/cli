#!/usr/bin/env node
import "./net.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  runAgentInstall,
  runAgentStatus,
  runAgentUninstall,
} from "./commands/agent.js";
import { runInit, runInitNonInteractive } from "./commands/init.js";

await yargs(hideBin(process.argv))
  .scriptName("superlog")
  .command(
    ["init", "$0"],
    "Instrument this project and verify ingest",
    (y) =>
      y
        .option("cwd", {
          type: "string",
          default: process.cwd(),
          describe: "Project directory to instrument",
        })
        .option("non-interactive", {
          type: "boolean",
          default: false,
          describe: "Skip the TUI — print events to stdout, exit non-zero on failure",
        })
        .option("token", {
          type: "string",
          describe: "CLI session token (superlog_cli_*); falls back to SUPERLOG_TOKEN env var or cached login",
        })
        .option("ingest-key", {
          type: "string",
          describe: "Project ingest key (superlog_live_*); falls back to SUPERLOG_INGEST_KEY env var or cached login",
        })
        .option("gateway-url", {
          type: "string",
          describe: "LLM gateway base URL (overrides SUPERLOG_GATEWAY_URL)",
        })
        .option("region", {
          type: "string",
          describe: "OTLP ingest base URL written into the project env file (overrides SUPERLOG_INGEST_URL)",
        }),
    async (argv) => {
      const nonInteractive =
        argv["non-interactive"] || !!argv.token || !!argv["ingest-key"];
      if (nonInteractive) {
        await runInitNonInteractive({
          cwd: argv.cwd,
          token: argv.token,
          ingestKey: argv["ingest-key"],
          gatewayUrl: argv["gateway-url"],
          region: argv.region,
        });
      } else {
        await runInit({ cwd: argv.cwd });
      }
    },
  )
  .command(
    "agent <action>",
    "Manage the on-host Superlog agent (macOS)",
    (y) =>
      y
        .positional("action", {
          type: "string",
          choices: ["install", "status", "uninstall"] as const,
          demandOption: true,
        })
        .option("endpoint", {
          type: "string",
          describe: "OTLP/HTTP base URL (install only)",
        })
        .option("token", {
          type: "string",
          describe: "Superlog ingest token (install only)",
        })
        .option("project-id", {
          type: "string",
          describe: "Superlog project id (install only)",
        })
        .option("service-name", {
          type: "string",
          describe: "service.name resource attribute (install only)",
        })
        .option("collector-bin", {
          type: "string",
          describe: "Path to otelcol-contrib (overrides brew prefix)",
        })
        .option("share", {
          type: "string",
          describe: "Path to superlog-agent templates (overrides brew prefix)",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Print what install would do without touching disk or launchd",
        }),
    async (argv) => {
      const action = argv.action as "install" | "status" | "uninstall";
      try {
        if (action === "install") {
          const missing = ["endpoint", "token", "project-id", "service-name"].filter(
            (k) => !argv[k as keyof typeof argv],
          );
          if (missing.length > 0) {
            console.error(`agent install requires: --${missing.join(", --")}`);
            process.exit(2);
          }
          await runAgentInstall({
            endpoint: argv.endpoint as string,
            token: argv.token as string,
            projectId: argv["project-id"] as string,
            serviceName: argv["service-name"] as string,
            collectorBin: argv["collector-bin"] as string | undefined,
            share: argv.share as string | undefined,
            dryRun: argv["dry-run"] as boolean,
          });
        } else if (action === "status") {
          await runAgentStatus();
        } else if (action === "uninstall") {
          await runAgentUninstall();
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  )
  .strict()
  .version()
  .help()
  .parse();
