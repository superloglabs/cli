import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Runtime = "node" | "python" | "go" | "applescript" | "monorepo" | "unknown";

export type Framework =
  | "next"
  | "nuxt"
  | "hono"
  | "express"
  | "fastify"
  | "nestjs"
  | "fastapi"
  | "django"
  | "flask"
  | "gin"
  | "echo"
  | "vite"
  | "plain";

// Libraries that need their own OTel wiring layered on top of the primary
// framework's recipe — Temporal needs interceptors regardless of whether the
// host process is Hono, Express, or a standalone worker; LiveKit agents have a
// dedicated telemetry hook in Python.
export type SubFramework =
  | "temporal-worker"
  | "temporal-client"
  | "livekit-agents"
  | "livekit-server"
  | "livekit-client";

export type Detection = {
  runtime: Runtime;
  framework: Framework;
  subFrameworks: SubFramework[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "go" | "unknown";
};

export async function detect(cwd: string): Promise<Detection> {
  // Check for monorepo workspace roots before treating package.json as a single Node app.
  const pkgManager = await detectNodePackageManager(cwd);
  if (await exists(join(cwd, "pnpm-workspace.yaml"))) {
    return { runtime: "monorepo", framework: "plain", subFrameworks: [], packageManager: pkgManager };
  }
  if (await exists(join(cwd, "package.json"))) {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    if (pkg.workspaces) {
      return { runtime: "monorepo", framework: "plain", subFrameworks: [], packageManager: pkgManager };
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      runtime: "node",
      framework: detectNodeFramework(deps),
      subFrameworks: detectNodeSubFrameworks(deps),
      packageManager: pkgManager,
    };
  }

  if (await exists(join(cwd, "pyproject.toml"))) {
    const text = await readFile(join(cwd, "pyproject.toml"), "utf8");
    return {
      runtime: "python",
      framework: detectPythonFramework(text),
      subFrameworks: detectPythonSubFrameworks(text),
      packageManager: "poetry",
    };
  }
  if (await exists(join(cwd, "requirements.txt"))) {
    const text = await readFile(join(cwd, "requirements.txt"), "utf8");
    return {
      runtime: "python",
      framework: detectPythonFramework(text),
      subFrameworks: detectPythonSubFrameworks(text),
      packageManager: "pip",
    };
  }
  if (await exists(join(cwd, "go.mod"))) {
    return { runtime: "go", framework: "plain", subFrameworks: [], packageManager: "go" };
  }

  if (process.platform === "darwin" && (await hasAppleScript(cwd))) {
    return { runtime: "applescript", framework: "plain", subFrameworks: [], packageManager: "unknown" };
  }

  return { runtime: "unknown", framework: "plain", subFrameworks: [], packageManager: "unknown" };
}

// Shallow scan of cwd + one level — catches the common layouts (flat folder of
// scripts, or a `scripts/` / `automation/` subdir) without walking the whole
// tree. A deep scan is the agent's job via Glob once we've committed to the
// applescript runtime.
async function hasAppleScript(cwd: string): Promise<boolean> {
  if (await scanForAppleScript(cwd)) return true;
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      if (await scanForAppleScript(join(cwd, e.name))) return true;
    }
  } catch {
    // unreadable dir — treat as no match
  }
  return false;
}

async function scanForAppleScript(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.endsWith(".applescript") || e.name.endsWith(".scpt")) return true;
      // .scptd is an AppleScript bundle — a directory ending in .scptd
      if (e.isDirectory() && e.name.endsWith(".scptd")) return true;
    }
  } catch {
    // unreadable — no match
  }
  return false;
}

function detectNodeFramework(deps: Record<string, string>): Framework {
  if (deps.next) return "next";
  if (deps.nuxt) return "nuxt";
  if (deps["@nestjs/core"]) return "nestjs";
  if (deps.fastify) return "fastify";
  if (deps.express) return "express";
  if (deps.hono) return "hono";
  if (deps.vite) return "vite";
  return "plain";
}

function detectNodeSubFrameworks(deps: Record<string, string>): SubFramework[] {
  const subs: SubFramework[] = [];
  // Worker is the only Temporal package that needs the full plugin wiring at
  // Worker.create. A project with @temporalio/client alone just needs the
  // outbound interceptor for trace propagation when starting workflows.
  if (deps["@temporalio/worker"]) subs.push("temporal-worker");
  else if (deps["@temporalio/client"]) subs.push("temporal-client");
  if (deps["@livekit/agents"]) subs.push("livekit-agents");
  if (deps["livekit-server-sdk"]) subs.push("livekit-server");
  if (deps["livekit-client"]) subs.push("livekit-client");
  return subs;
}

function detectPythonSubFrameworks(manifest: string): SubFramework[] {
  const subs: SubFramework[] = [];
  const lower = manifest.toLowerCase();
  if (/(^|[^a-z0-9_-])temporalio([^a-z0-9_-]|$)/.test(lower)) {
    // Python doesn't split worker/client into separate packages — assume
    // worker until we have a reason not to (the worker recipe covers both).
    subs.push("temporal-worker");
  }
  if (/(^|[^a-z0-9_-])livekit-agents([^a-z0-9_-]|$)/.test(lower)) {
    subs.push("livekit-agents");
  }
  return subs;
}

function detectPythonFramework(manifest: string): Framework {
  const lower = manifest.toLowerCase();
  if (/(^|[^a-z0-9_-])fastapi([^a-z0-9_-]|$)/.test(lower)) return "fastapi";
  if (/(^|[^a-z0-9_-])django([^a-z0-9_-]|$)/.test(lower)) return "django";
  if (/(^|[^a-z0-9_-])flask([^a-z0-9_-]|$)/.test(lower)) return "flask";
  return "plain";
}

async function detectNodePackageManager(cwd: string): Promise<Detection["packageManager"]> {
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
