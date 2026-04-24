import {
  AGENT_MARKERS,
  type AgentInput,
  type AgentReport,
  buildSystemPrompt,
  buildTaskPrompt,
} from "./prompt.js";

export type AgentEvent =
  | { kind: "status"; message: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "text"; message: string }
  | { kind: "report"; report: AgentReport }
  | { kind: "done"; message?: string }
  | { kind: "partial"; reason: string }
  | { kind: "abort"; reason: string }
  | { kind: "error"; message: string };

export type RunAgentOptions = {
  input: AgentInput;
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
};

const MODEL = "claude-sonnet-4-6";

const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  // Route the agent SDK through the superlog gateway. The SDK reads these at import
  // time, so set them *before* the dynamic import. Strip any user-provided
  // Anthropic credentials so we never leak them upstream.
  process.env.ANTHROPIC_BASE_URL = opts.input.gatewayUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = opts.input.token;
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "true";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const abortController = new AbortController();
  const relayAbort = () => abortController.abort();
  opts.signal?.addEventListener("abort", relayAbort);

  // Keep stdin open until result received — see claude-agent-sdk#41.
  let signalDone: () => void = () => {};
  const resultReceived = new Promise<void>((resolve) => {
    signalDone = resolve;
  });

  const task = buildTaskPrompt(opts.input);
  const promptStream = async function* () {
    yield {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: task },
      parent_tool_use_id: null,
    };
    await resultReceived;
  };

  try {
    const response = query({
      prompt: promptStream(),
      options: {
        abortController,
        model: MODEL,
        cwd: opts.input.cwd,
        systemPrompt: buildSystemPrompt(),
        permissionMode: "acceptEdits",
        allowedTools: ALLOWED_TOOLS,
        maxTurns: 30,
      },
    });

    for await (const message of response) {
      handleMessage(message, opts.onEvent);
      if (message?.type === "result") {
        signalDone();
      }
    }
  } catch (err) {
    opts.onEvent({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    opts.signal?.removeEventListener("abort", relayAbort);
  }
}

function handleMessage(message: any, emit: (e: AgentEvent) => void): void {
  if (!message || typeof message !== "object") return;

  if (message.type === "assistant") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        parseMarkers(block.text, emit);
      } else if (block.type === "tool_use") {
        emit({
          kind: "tool",
          name: block.name ?? "tool",
          summary: summarizeToolUse(block),
        });
      }
    }
    return;
  }

  if (message.type === "result") {
    if (message.subtype === "success") {
      emit({ kind: "done" });
    } else {
      emit({
        kind: "error",
        message: message.error?.message ?? "Agent run ended without success.",
      });
    }
  }
}

function parseMarkers(text: string, emit: (e: AgentEvent) => void): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(AGENT_MARKERS.status)) {
      emit({ kind: "status", message: trimmed.slice(AGENT_MARKERS.status.length).trim() });
    } else if (trimmed.startsWith(AGENT_MARKERS.report)) {
      const report = parseReport(trimmed.slice(AGENT_MARKERS.report.length).trim());
      if (report) emit({ kind: "report", report });
      // silently drop malformed reports — the Verify step falls back to
      // heuristic service-name derivation so this isn't fatal.
    } else if (trimmed.startsWith(AGENT_MARKERS.partial)) {
      emit({ kind: "partial", reason: trimmed.slice(AGENT_MARKERS.partial.length).trim() });
    } else if (trimmed.startsWith(AGENT_MARKERS.abort)) {
      emit({ kind: "abort", reason: trimmed.slice(AGENT_MARKERS.abort.length).trim() });
    } else if (trimmed.startsWith(AGENT_MARKERS.done)) {
      emit({ kind: "done", message: trimmed.slice(AGENT_MARKERS.done.length).trim() });
    } else {
      emit({ kind: "text", message: trimmed });
    }
  }
}

function parseReport(payload: string): AgentReport | null {
  try {
    const parsed = JSON.parse(payload) as { service?: unknown; signals?: unknown };
    if (typeof parsed.service !== "string" || !parsed.service.trim()) return null;
    const allowed = new Set(["traces", "logs", "metrics"]);
    const signals = Array.isArray(parsed.signals)
      ? parsed.signals.filter((s): s is AgentReport["signals"][number] =>
          typeof s === "string" && allowed.has(s),
        )
      : [];
    return { service: parsed.service.trim(), signals };
  } catch {
    return null;
  }
}

function summarizeToolUse(block: any): string {
  const input = block.input ?? {};
  switch (block.name) {
    case "Bash":
      return oneLine(String(input.command ?? ""), 80);
    case "Read":
    case "Write":
    case "Edit":
      return oneLine(String(input.file_path ?? "").replace(process.cwd(), "."), 80);
    case "Glob":
      return oneLine(String(input.pattern ?? ""), 80);
    case "Grep":
      return oneLine(String(input.pattern ?? ""), 80);
    default:
      return "";
  }
}

// Collapse whitespace and cap length — Ink's layout breaks when a single
// Text node contains a newline (multi-line bash commands were the trigger).
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
