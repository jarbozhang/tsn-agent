import type { AgentStepDetail } from "./agent-types";

export const AGENT_STEP_MAX_BYTES = 16 * 1024;
export const AGENT_RUN_MAX_STEPS = 200;
export const AGENT_RUN_MAX_UNPAIRED_STEPS = 30;
export const AGENT_STALL_TIMEOUT_MS_DEFAULT = 90_000;

const STEP_DETAIL_ALLOWLIST: ReadonlySet<keyof AgentStepDetail> = new Set([
  "traceId",
  "runId",
  "toolUseId",
  "toolName",
  "status",
  "inputSummary",
  "outputSummary",
  "errorSummary",
  "durationMs",
  "counts",
  "createdAt",
]);

export interface SanitizedAgentStepDetail {
  detail: AgentStepDetail;
  droppedKeys: string[];
}

export function sanitizeAgentStepDetail(raw: Record<string, unknown>): SanitizedAgentStepDetail {
  const droppedKeys: string[] = [];
  const allowed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (STEP_DETAIL_ALLOWLIST.has(key as keyof AgentStepDetail)) {
      allowed[key] = value;
    } else {
      droppedKeys.push(key);
    }
  }

  if (typeof allowed.traceId !== "string" || allowed.traceId.length === 0) {
    throw new Error("sanitizeAgentStepDetail: missing required field `traceId`");
  }
  if (typeof allowed.runId !== "string" || allowed.runId.length === 0) {
    throw new Error("sanitizeAgentStepDetail: missing required field `runId`");
  }
  if (typeof allowed.status !== "string") {
    allowed.status = "info";
  }

  return {
    detail: allowed as unknown as AgentStepDetail,
    droppedKeys,
  };
}

const VENDOR_REPLACEMENT = "智能助手";
const RUNTIME_HOST_PLACEHOLDER = "[runtime-host]";

const VENDOR_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /api\.anthropic\.com/gi, replacement: RUNTIME_HOST_PLACEHOLDER },
  { pattern: /x-anthropic-[a-z0-9-]+/gi, replacement: "x-runtime-header" },
  { pattern: /\bx-request-id\b/gi, replacement: "x-request-id-redacted" },
  { pattern: /claude-[a-z0-9][a-z0-9-]*/gi, replacement: VENDOR_REPLACEMENT },
  { pattern: /\bAnthropic\b/gi, replacement: VENDOR_REPLACEMENT },
  { pattern: /\banthropic\b/g, replacement: VENDOR_REPLACEMENT },
  { pattern: /\bClaude\b/gi, replacement: VENDOR_REPLACEMENT },
];

export function redactVendorNames(text: string): string {
  let result = text;
  for (const { pattern, replacement } of VENDOR_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function payloadByteLength(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

export function isOversizedAgentStepPayload(payload: unknown): boolean {
  return payloadByteLength(payload) > AGENT_STEP_MAX_BYTES;
}
