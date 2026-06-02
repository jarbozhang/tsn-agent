import type { Page } from "@playwright/test";

/**
 * Enable the dev-only Playwright test runtime swap before App mounts.
 * Pair with main.tsx's `__TSN_TEST_RUNTIME__` flag.
 */
export async function enableTestRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __TSN_TEST_RUNTIME__?: boolean }).__TSN_TEST_RUNTIME__ = true;
  });
}
