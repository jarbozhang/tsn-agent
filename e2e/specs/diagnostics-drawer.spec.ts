import { expect, test } from "@playwright/test";
import { enableTestRuntime } from "../fixtures/test-runtime";

test.describe("diagnostics drawer", () => {
  test.beforeEach(async ({ page }) => {
    await enableTestRuntime(page);
  });

  test("opens the diagnostics drawer and shows logs after a submission", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要2个交换机，每个交换机连接2个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("交换机 2")).toBeVisible();

    await page.getByRole("button", { name: /日志/ }).first().click();
    await expect(page.getByRole("complementary", { name: "日志" })).toBeVisible();
    await expect(page.getByLabel("当前会话诊断日志").getByText("用户提交需求").first()).toBeVisible();
  });
});
