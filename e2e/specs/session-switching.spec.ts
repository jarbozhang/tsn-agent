import { expect, test } from "@playwright/test";
import { enableTestRuntime } from "../fixtures/test-runtime";

test.describe("session switching", () => {
  test.beforeEach(async ({ page }) => {
    await enableTestRuntime(page);
  });

  test("opens the sessions drawer and creates a new session", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "TSN Agent" })).toBeVisible();

    await page.getByRole("button", { name: /会话/ }).first().click();
    await expect(page.getByRole("complementary", { name: "会话管理" })).toBeVisible();

    await page.getByRole("button", { name: "新建会话" }).click();
    // The new session prefills the intent input.
    await expect(page.getByLabel("输入你的 TSN 需求")).toHaveValue(/4个交换机/);
  });
});
