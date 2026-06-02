import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestRuntime, isTestRuntimeRequested, resetTestRuntime } from "./playwright-runtime-bridge";

describe("playwright-runtime-bridge", () => {
  beforeEach(() => {
    resetTestRuntime();
  });

  afterEach(() => {
    resetTestRuntime();
  });

  it("isTestRuntimeRequested returns false by default", () => {
    expect(isTestRuntimeRequested()).toBe(false);
  });

  it("isTestRuntimeRequested returns true when flag is set", () => {
    window.__TSN_TEST_RUNTIME__ = true;
    expect(isTestRuntimeRequested()).toBe(true);
  });

  it("installTestRuntime exposes a window.__TSN_TEST_DISPATCHER__ function", () => {
    expect(window.__TSN_TEST_DISPATCHER__).toBeUndefined();
    installTestRuntime();
    expect(typeof window.__TSN_TEST_DISPATCHER__).toBe("function");
  });

  it("installTestRuntime forces the Tauri runtime sentinel so adapter detects desktop", () => {
    installTestRuntime();
    expect(window.__TAURI_INTERNALS__).toBeDefined();
    expect((window.__TAURI_INTERNALS__ as { __testRuntime?: boolean }).__testRuntime).toBe(true);
  });

  it("installTestRuntime is idempotent — a second call does not overwrite a real __TAURI_INTERNALS__", () => {
    window.__TAURI_INTERNALS__ = { ipc: () => undefined };
    installTestRuntime();
    expect((window.__TAURI_INTERNALS__ as { ipc?: unknown }).ipc).toBeDefined();
    // second install should still be safe (guarded by `installed`)
    installTestRuntime();
    expect((window.__TAURI_INTERNALS__ as { ipc?: unknown }).ipc).toBeDefined();
  });

  it("the installed dispatcher returns a TsnAgentResult-shaped object for an intent", async () => {
    installTestRuntime();
    const dispatcher = window.__TSN_TEST_DISPATCHER__;
    expect(dispatcher).toBeDefined();
    const result = await dispatcher!({ userIntent: "我需要2个交换机，每个交换机连接2个端系统" });
    expect(result).toBeDefined();
    expect(typeof result.kind).toBe("string");
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.assistantText).toBe("string");
    expect(Array.isArray(result.agentSteps)).toBe(true);
    expect(typeof result.runId).toBe("string");
  });

  it("resetTestRuntime clears window state and allows re-installation", () => {
    // ensure no residue from previous tests (an earlier case may have set a
    // synthetic real __TAURI_INTERNALS__ that resetTestRuntime preserves).
    delete window.__TAURI_INTERNALS__;
    installTestRuntime();
    expect(window.__TSN_TEST_DISPATCHER__).toBeDefined();
    resetTestRuntime();
    expect(window.__TSN_TEST_DISPATCHER__).toBeUndefined();
    expect(window.__TAURI_INTERNALS__).toBeUndefined();
    installTestRuntime();
    expect(window.__TSN_TEST_DISPATCHER__).toBeDefined();
  });
});
