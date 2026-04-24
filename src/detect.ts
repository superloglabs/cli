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

export type Detection = {
  runtime: Runtime;
  framework: Framework;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "go" | "unknown";
};

export async function detect(cwd: string): Promise<Detection> {
  // Check for monorepo workspace roots before treating package.json as a single Node app.
  const pkgManager = await detectNodePackageManager(cwd);
  if (await exists(join(cwd, "pnpm-workspace.yaml"))) {
    return { runtime: "monorepo", framework: "plain", packageManager: pkgManager };
  }
  if (await exists(join(cwd, "package.json"))) {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    if (pkg.workspaces) {
      return { runtime: "monorepo", framework: "plain", packageManager: pkgManager };
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      runtime: "node",
      framework: detectNodeFramework(deps),
      packageManager: pkgManager,
    };
  }

  if (await exists(join(cwd, "pyproject.toml"))) {
    return { runtime: "python", framework: "plain", packageManager: "poetry" };
  }
  if (await exists(join(cwd, "requirements.txt"))) {
    return { runtime: "python", framework: "plain", packageManager: "pip" };
  }
  if (await exists(join(cwd, "go.mod"))) {
    return { runtime: "go", framework: "plain", packageManager: "go" };
  }

  if (process.platform === "darwin" && (await hasAppleScript(cwd))) {
    return { runtime: "applescript", framework: "plain", packageManager: "unknown" };
  }

  return { runtime: "unknown", framework: "plain", packageManager: "unknown" };
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
