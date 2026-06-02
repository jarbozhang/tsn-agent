import { expect, test } from "@playwright/test";
import { enableTestRuntime } from "../fixtures/test-runtime";

test.describe("topology editing", () => {
  test.beforeEach(async ({ page }) => {
    await enableTestRuntime(page);
  });

  test("updates topology when switch count changes", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要2个交换机，每个交换机连接5个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("交换机 2")).toBeVisible();

    await page.getByLabel("输入你的 TSN 需求").fill("修改一下拓扑，从2交换机变为3交换机");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("交换机 3")).toBeVisible();
    await expect(page.getByText("端系统 15")).toBeVisible();
  });
});
