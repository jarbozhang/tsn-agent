import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_MAX_STEPS,
  AGENT_RUN_MAX_UNPAIRED_STEPS,
  AGENT_STALL_TIMEOUT_MS_DEFAULT,
  AGENT_STEP_MAX_BYTES,
  isOversizedAgentStepPayload,
  payloadByteLength,
  redactVendorNames,
  sanitizeAgentStepDetail,
} from "./agent-sanitizer";

describe("agent-sanitizer constants", () => {
  it("AGENT_STEP_MAX_BYTES is 16KB", () => {
    expect(AGENT_STEP_MAX_BYTES).toBe(16 * 1024);
  });

  it("AGENT_RUN_MAX_STEPS is 200", () => {
    expect(AGENT_RUN_MAX_STEPS).toBe(200);
  });

  it("AGENT_RUN_MAX_UNPAIRED_STEPS is 30", () => {
    expect(AGENT_RUN_MAX_UNPAIRED_STEPS).toBe(30);
  });

  it("AGENT_STALL_TIMEOUT_MS_DEFAULT is 90 seconds", () => {
    expect(AGENT_STALL_TIMEOUT_MS_DEFAULT).toBe(90_000);
  });
});

describe("sanitizeAgentStepDetail", () => {
  const baseInput = {
    traceId: "trace-1",
    runId: "run-1",
    status: "success",
    toolName: "topology.initialize",
    inputSummary: "scale=4",
    outputSummary: "nodes=12, links=11",
    durationMs: 123,
  };

  it("retains only allowlist fields", () => {
    const { detail, droppedKeys } = sanitizeAgentStepDetail(baseInput);
    expect(detail.traceId).toBe("trace-1");
    expect(detail.runId).toBe("run-1");
    expect(detail.status).toBe("success");
    expect(detail.toolName).toBe("topology.initialize");
    expect(detail.inputSummary).toBe("scale=4");
    expect(detail.outputSummary).toBe("nodes=12, links=11");
    expect(detail.durationMs).toBe(123);
    expect(droppedKeys).toEqual([]);
  });

  it("drops raw-bearing keys with fail-closed semantics", () => {
    const { detail, droppedKeys } = sanitizeAgentStepDetail({
      ...baseInput,
      prompt: "secret prompt content",
      conversationContext: { messages: [{ role: "user", content: "hi" }] },
      stdout: "raw stdout",
      stderr: "raw stderr",
      headers: { authorization: "Bearer sk-ant-xxx" },
      authorization: "Bearer xxx",
      cookie: "session=abc",
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      full: { topology: { nodes: [], links: [] } },
      topology: { nodes: [], links: [] },
      changeSet: { added: [], removed: [] },
      artifact: { binary: "..." },
    });
    expect(detail).not.toHaveProperty("prompt");
    expect(detail).not.toHaveProperty("stdout");
    expect(detail).not.toHaveProperty("headers");
    expect(detail).not.toHaveProperty("authorization");
    expect(detail).not.toHaveProperty("topology");
    expect(detail).not.toHaveProperty("changeSet");
    expect(droppedKeys).toEqual(
      expect.arrayContaining([
        "prompt",
        "conversationContext",
        "stdout",
        "stderr",
        "headers",
        "authorization",
        "cookie",
        "env",
        "full",
        "topology",
        "changeSet",
        "artifact",
      ]),
    );
  });

  it("drops unknown keys fail-closed and records them in droppedKeys", () => {
    const input: Record<string, unknown> = {
      ...baseInput,
      foo: "bar",
      randomNewField: 42,
    };
    Object.defineProperty(input, "__proto_pollution_attempt", {
      value: { evil: true },
      enumerable: true,
    });
    const { detail, droppedKeys } = sanitizeAgentStepDetail(input);
    expect(detail).not.toHaveProperty("foo");
    expect(detail).not.toHaveProperty("randomNewField");
    expect(detail).not.toHaveProperty("__proto_pollution_attempt");
    expect(droppedKeys).toEqual(
      expect.arrayContaining(["foo", "randomNewField", "__proto_pollution_attempt"]),
    );
  });

  it("defaults missing status to 'info'", () => {
    const { detail } = sanitizeAgentStepDetail({
      traceId: "trace-2",
      runId: "run-2",
    });
    expect(detail.status).toBe("info");
  });

  it("throws when required traceId is missing", () => {
    expect(() => sanitizeAgentStepDetail({ runId: "run-3" })).toThrow(/traceId/);
  });

  it("throws when required runId is missing", () => {
    expect(() => sanitizeAgentStepDetail({ traceId: "trace-3" })).toThrow(/runId/);
  });

  it("retains counts as a record of numbers", () => {
    const { detail } = sanitizeAgentStepDetail({
      ...baseInput,
      counts: { nodes: 4, links: 6 },
    });
    expect(detail.counts).toEqual({ nodes: 4, links: 6 });
  });
});

describe("redactVendorNames", () => {
  it("replaces 'anthropic' / 'Anthropic' with neutral name", () => {
    expect(redactVendorNames("This is anthropic SDK")).toContain("智能助手");
    expect(redactVendorNames("This is Anthropic SDK")).toContain("智能助手");
    expect(redactVendorNames("anthropic")).toBe("智能助手");
  });

  it("replaces 'Claude' (case-insensitive)", () => {
    expect(redactVendorNames("Hello from Claude")).toContain("智能助手");
    expect(redactVendorNames("hello from claude")).toContain("智能助手");
  });

  it("replaces model names with claude-* prefix", () => {
    expect(redactVendorNames("model: claude-sonnet-4-5-20250929")).not.toContain("claude-sonnet");
    expect(redactVendorNames("model: claude-opus-4-7")).not.toContain("claude-opus");
  });

  it("replaces api.anthropic.com host", () => {
    expect(redactVendorNames("calling https://api.anthropic.com/v1/messages")).toContain(
      "[runtime-host]",
    );
    expect(redactVendorNames("api.anthropic.com")).not.toContain("anthropic.com");
  });

  it("replaces x-anthropic-* headers", () => {
    expect(redactVendorNames("x-anthropic-organization: org_xyz")).toContain("x-runtime-header");
  });

  it("redacts x-request-id label", () => {
    expect(redactVendorNames("x-request-id: req_xyz")).toContain("x-request-id-redacted");
  });

  it("leaves vendor-free text unchanged", () => {
    expect(redactVendorNames("智能助手运行时不可用")).toBe("智能助手运行时不可用");
    expect(redactVendorNames("topology.initialize succeeded")).toBe("topology.initialize succeeded");
  });

  it("handles multiple vendor markers in a single string", () => {
    const input = "Anthropic Claude model claude-sonnet-4-5 from api.anthropic.com";
    const output = redactVendorNames(input);
    expect(output).not.toMatch(/anthropic/i);
    expect(output).not.toMatch(/Claude/);
    expect(output).not.toMatch(/claude-sonnet/);
    expect(output).toContain("[runtime-host]");
  });
});

describe("payloadByteLength / isOversizedAgentStepPayload", () => {
  it("payloadByteLength returns UTF-8 byte length of JSON", () => {
    expect(payloadByteLength({ a: 1 })).toBe(7);
    expect(payloadByteLength("中文")).toBe(8);
  });

  it("isOversizedAgentStepPayload returns false for tiny payloads", () => {
    expect(isOversizedAgentStepPayload({ traceId: "t", runId: "r" })).toBe(false);
  });

  it("isOversizedAgentStepPayload returns true for payloads > 16KB", () => {
    const huge = { blob: "x".repeat(17_000) };
    expect(isOversizedAgentStepPayload(huge)).toBe(true);
  });

  it("isOversizedAgentStepPayload boundary at exactly 16KB+1", () => {
    const exact = "x".repeat(AGENT_STEP_MAX_BYTES + 1);
    expect(isOversizedAgentStepPayload(exact)).toBe(true);
  });
});
