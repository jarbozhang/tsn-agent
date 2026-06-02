/**
 * Playwright test-only runtime swap.
 *
 * When the page sets `window.__TSN_TEST_RUNTIME__ = true` before App mounts,
 * `main.tsx` (in development mode only) imports this module and calls
 * `installTestRuntime()`. That replaces the agent-adapter's runtime check so
 * `runTsnAgent` dispatches through `dispatchAgentStage` from the same fixture
 * builders the vitest suite uses.
 *
 * Production builds NEVER include this module — `import.meta.env.MODE` is a
 * compile-time constant, so Vite tree-shakes the dynamic import branch.
 */
import { dispatchAgentStage } from "./agent-stage-dispatcher";
import type { TsnAgentRequest, TsnAgentResult } from "../agent/agent-adapter";

const ORIGINAL_TAURI_KEY = "__TAURI_INTERNALS__";

let installed = false;

export function installTestRuntime(): void {
  if (installed) {
    return;
  }
  installed = true;

  // Force the adapter's `isTauriRuntime()` check to return true so it follows
  // the success path instead of fail-closed. The dispatcher provides the
  // fixture result before the worker would be invoked.
  if (!(ORIGINAL_TAURI_KEY in window)) {
    Object.defineProperty(window, ORIGINAL_TAURI_KEY, {
      configurable: true,
      value: { __testRuntime: true },
    });
  }

  // Monkey-patch the adapter's runTsnAgent. We can't override it on the
  // module export directly (ESM exports are frozen in some environments) so we
  // tag a fallback on window that App.tsx can opt into.
  const dispatcher = async (request: TsnAgentRequest | string): Promise<TsnAgentResult> => {
    const userIntent = typeof request === "string" ? request : request.userIntent;
    const session = typeof request === "string" ? undefined : request.session;
    const runId = typeof request === "string" ? undefined : request.runId;
    const result = dispatchAgentStage({
      userIntent,
      session: session as Parameters<typeof dispatchAgentStage>[0]["session"],
    });
    return {
      ...result,
      shouldApplyProject: (result as { shouldApplyProject?: boolean }).shouldApplyProject ?? false,
      agentSteps: [],
      runId: runId ?? "test-run-id",
    } as TsnAgentResult;
  };

  (window as unknown as { __TSN_TEST_DISPATCHER__?: typeof dispatcher }).__TSN_TEST_DISPATCHER__ = dispatcher;
}

export function isTestRuntimeRequested(): boolean {
  return Boolean((window as unknown as { __TSN_TEST_RUNTIME__?: boolean }).__TSN_TEST_RUNTIME__);
}
