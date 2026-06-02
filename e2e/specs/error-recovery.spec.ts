import { expect, test } from "@playwright/test";
import { enableTestRuntime } from "../fixtures/test-runtime";

test.describe("error recovery", () => {
  test.beforeEach(async ({ page }) => {
    await enableTestRuntime(page);
  });

  test("topology stays applied after a follow-up ring interconnect edit", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要3个交换机，每个交换机连接5个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("交换机 3")).toBeVisible();
    await expect(page.getByText("端系统 15")).toBeVisible();

    await page.getByLabel("输入你的 TSN 需求").fill("可以使用环形互联");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    // After ring edit, switch and host counts must NOT collapse to defaults.
    await expect(page.getByText("交换机 3")).toBeVisible();
    await expect(page.getByText("端系统 15")).toBeVisible();
  });
});
