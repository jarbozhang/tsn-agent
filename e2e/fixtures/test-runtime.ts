import type { Page } from "@playwright/test";

/**
 * Enable the dev-only Playwright test runtime swap before App mounts.
 * Pair with main.tsx's `__TSN_TEST_RUNTIME__` flag.
 */
export async function enableTestRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window).__TSN_TEST_RUNTIME__ = true;
  });
}

/**
 * Enable the test runtime AND set an error-mode so the dispatcher returns a
 * failure-preserved result. Used to drive error-path UI flows in e2e.
 */
export async function enableTestRuntimeWithError(
  page: Page,
  mode: "agent_error" | "stall_timeout" | "no_stage_result",
): Promise<void> {
  await page.addInitScript((m) => {
    (window as Window).__TSN_TEST_RUNTIME__ = true;
    (window as Window).__TSN_TEST_ERROR_MODE__ = m as "agent_error" | "stall_timeout" | "no_stage_result";
  }, mode);
}
