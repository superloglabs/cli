import { execFile as execFileCb } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const LABEL = "sh.superlog.agent";

export type InstallOptions = {
  endpoint: string;
  token: string;
  projectId: string;
  serviceName: string;
  collectorBin?: string;
  share?: string;
  dryRun?: boolean;
};

export async function runAgentInstall(opts: InstallOptions): Promise<void> {
  requireDarwin();
  const p = resolvePaths(opts);
  await verifyBinaries(p);
  if (opts.dryRun) {
    console.log("dry-run — would write:");
    console.log(`  ${p.configOut}`);
    console.log(`  ${p.plistOut}`);
    console.log(`  ${p.tokenFile} (0600)`);
    console.log(`would then: launchctl bootstrap gui/<uid> ${p.plistOut}`);
    return;
  }
  await ensureDirs(p);
  await writeToken(p, opts.token);
  await writeConfig(p);
  await writePlist(p, opts);
  await bootstrap(p);
  console.log(`agent installed — ${LABEL} is loaded`);
  console.log(`  config: ${p.configOut}`);
  console.log(`  plist:  ${p.plistOut}`);
  console.log(`  logs:   ${p.logDir}/collector.stderr.log`);
}

export async function runAgentStatus(): Promise<void> {
  requireDarwin();
  const p = resolvePaths();
  const loaded = await launchctlLoaded();
  console.log(`launchd:     ${loaded ? "loaded" : "not loaded"}`);
  console.log(`plist:       ${existsSync(p.plistOut) ? p.plistOut : "<missing>"}`);
  console.log(`config:      ${existsSync(p.configOut) ? p.configOut : "<missing>"}`);
  console.log(`script log:  ${existsSync(p.scriptsLog) ? p.scriptsLog : "<none yet>"}`);
  if (existsSync(p.scriptsLog)) {
    const last = await tailOne(p.scriptsLog);
    console.log(`last event:  ${last ?? "<empty file>"}`);
  }
}

export async function runAgentUninstall(): Promise<void> {
  requireDarwin();
  const p = resolvePaths();
  await bootout();
  await rm(p.plistOut, { force: true });
  await rm(p.configOut, { force: true });
  await rm(p.tokenFile, { force: true });
  console.log("agent uninstalled");
  console.log(`  preserved: ${p.scriptsLog} (instrumented scripts still write here)`);
}

// ---------- internals ----------

type Paths = {
  share: string;
  collectorBin: string;
  configSrc: string;
  plistSrc: string;
  configOut: string;
  plistOut: string;
  logDir: string;
  appSupport: string;
  tokenFile: string;
  storageDir: string;
  scriptsLog: string;
  stdoutLog: string;
  stderrLog: string;
};

function resolvePaths(opts?: { share?: string; collectorBin?: string }): Paths {
  const home = homedir();
  const share =
    opts?.share ?? process.env.SUPERLOG_AGENT_SHARE ?? `${brewPrefix()}/share/superlog-agent`;
  const collectorBin =
    opts?.collectorBin ??
    process.env.SUPERLOG_COLLECTOR_BIN ??
    `${brewPrefix()}/bin/otelcol-contrib`;
  return {
    share,
    collectorBin,
    configSrc: join(share, "collector", "config.yaml"),
    plistSrc: join(share, "launchd", "sh.superlog.agent.plist"),
    configOut: join(home, "Library/Application Support/Superlog/collector.yaml"),
    plistOut: join(home, "Library/LaunchAgents/sh.superlog.agent.plist"),
    logDir: join(home, "Library/Logs/Superlog"),
    appSupport: join(home, "Library/Application Support/Superlog"),
    tokenFile: join(home, "Library/Application Support/Superlog/token"),
    storageDir: join(home, "Library/Application Support/Superlog/storage"),
    scriptsLog: join(home, "Library/Logs/Superlog/scripts.ndjson"),
    stdoutLog: join(home, "Library/Logs/Superlog/collector.stdout.log"),
    stderrLog: join(home, "Library/Logs/Superlog/collector.stderr.log"),
  };
}

// Cache across the process — brew --prefix is stable and we read it on every resolvePaths.
let brewPrefixCache: string | null = null;
function brewPrefix(): string {
  if (brewPrefixCache) return brewPrefixCache;
  // Apple Silicon default covers most current Macs; Intel fallback keeps older boxes working.
  // If neither is present we still return the arm64 path and let the later binary check fail loudly.
  brewPrefixCache = existsSync("/opt/homebrew/bin/brew")
    ? "/opt/homebrew"
    : existsSync("/usr/local/bin/brew")
      ? "/usr/local"
      : "/opt/homebrew";
  return brewPrefixCache;
}

function requireDarwin(): void {
  if (platform() !== "darwin") {
    throw new Error(`superlog agent runs on macOS only — detected ${platform()}`);
  }
}

async function verifyBinaries(p: Paths): Promise<void> {
  if (!existsSync(p.collectorBin)) {
    throw new Error(
      `Collector binary not found at ${p.collectorBin}.\n` +
        `Install with: brew install superloglabs/tap/superlog-agent\n` +
        `Or set SUPERLOG_COLLECTOR_BIN to override.`,
    );
  }
  if (!existsSync(p.configSrc) || !existsSync(p.plistSrc)) {
    throw new Error(
      `Agent templates not found under ${p.share}.\n` +
        `Install with: brew install superloglabs/tap/superlog-agent\n` +
        `Or set SUPERLOG_AGENT_SHARE to a local checkout of the superlog-agent repo.`,
    );
  }
}

async function ensureDirs(p: Paths): Promise<void> {
  await mkdir(p.logDir, { recursive: true });
  await mkdir(p.appSupport, { recursive: true });
  await mkdir(p.storageDir, { recursive: true });
}

async function writeToken(p: Paths, token: string): Promise<void> {
  await writeFile(p.tokenFile, token, { mode: 0o600 });
  await chmod(p.tokenFile, 0o600);
}

async function writeConfig(p: Paths): Promise<void> {
  // Config has no template placeholders — all values are ${env:...} resolved at
  // runtime by the Collector. Copy verbatim.
  await copyFile(p.configSrc, p.configOut);
}

async function writePlist(p: Paths, opts: InstallOptions): Promise<void> {
  const template = await readFile(p.plistSrc, "utf8");
  const rendered = template
    .replaceAll("@COLLECTOR_BIN@", p.collectorBin)
    .replaceAll("@CONFIG_PATH@", p.configOut)
    .replaceAll("@LOG_PATH@", p.scriptsLog)
    .replaceAll("@STORAGE_DIR@", p.storageDir)
    .replaceAll("@INGEST_ENDPOINT@", opts.endpoint)
    .replaceAll("@INGEST_TOKEN@", opts.token)
    .replaceAll("@PROJECT_ID@", opts.projectId)
    .replaceAll("@SERVICE_NAME@", opts.serviceName)
    .replaceAll("@STDOUT_PATH@", p.stdoutLog)
    .replaceAll("@STDERR_PATH@", p.stderrLog);
  await writeFile(p.plistOut, rendered, { mode: 0o600 });
  await chmod(p.plistOut, 0o600);
}

async function bootstrap(p: Paths): Promise<void> {
  const target = await domainTarget();
  // bootout first to tolerate re-install; ignore the "not loaded" failure mode.
  await execFile("launchctl", ["bootout", `${target}/${LABEL}`]).catch(() => {});
  await execFile("launchctl", ["bootstrap", target, p.plistOut]);
  await execFile("launchctl", ["kickstart", "-k", `${target}/${LABEL}`]).catch(() => {});
}

async function bootout(): Promise<void> {
  const target = await domainTarget();
  await execFile("launchctl", ["bootout", `${target}/${LABEL}`]).catch(() => {});
}

async function launchctlLoaded(): Promise<boolean> {
  const target = await domainTarget();
  try {
    await execFile("launchctl", ["print", `${target}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

async function domainTarget(): Promise<string> {
  // gui/<uid> is the per-user GUI domain; matches where LaunchAgents load.
  const { stdout } = await execFile("id", ["-u"]);
  return `gui/${stdout.trim()}`;
}

async function tailOne(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path, "utf8");
    const lines = buf.trimEnd().split("\n");
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}
