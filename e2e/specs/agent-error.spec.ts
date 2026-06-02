import { expect, test } from "@playwright/test";
import { enableTestRuntime, enableTestRuntimeWithError } from "../fixtures/test-runtime";

test.describe("agent error path", () => {
  test("agent_error preserves the previous topology and surfaces an error message", async ({ page, context }) => {
    await enableTestRuntime(page);
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要2个交换机，每个交换机连接2个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("交换机 2")).toBeVisible();

    // Switch to error mode for the next request. addInitScript runs on every
    // fresh page navigation, so reload before submitting the second intent.
    await context.addInitScript(() => {
      (window as Window).__TSN_TEST_ERROR_MODE__ = "agent_error";
    });
    await page.reload();

    await page.getByLabel("输入你的 TSN 需求").fill("修改一下拓扑");
    await page.getByRole("button", { name: "生成规划草案" }).click();

    // The prior topology should still be visible (failure-preserved).
    await expect(page.getByText("交换机 2")).toBeVisible();
    // Error assistant text should appear; the fixture builder uses a Chinese error message.
    await expect(page.getByText(/智能助手返回错误|保留当前状态/)).toBeVisible();
  });

  test("no_stage_result still preserves project and surfaces structured failure", async ({ page }) => {
    await enableTestRuntimeWithError(page, "no_stage_result");
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要2个交换机，每个交换机连接2个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    // No project gets applied → "拓扑等待确认" should NOT appear.
    await expect(page.getByText("拓扑等待确认")).not.toBeVisible({ timeout: 1500 });
    // Should mention "结构化拓扑结果" copy from the failure fixture
    await expect(page.getByText(/结构化拓扑结果|保留当前状态/)).toBeVisible();
  });
});
