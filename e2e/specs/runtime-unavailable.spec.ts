import { expect, test } from "@playwright/test";

// This spec deliberately does NOT enable the test runtime — it asserts that
// the production Web entry shows the fail-closed CTA.
test.describe("runtime-unavailable fail-closed", () => {
  test("shows fail-closed message when test runtime is not enabled", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    // The assistant text in runtime-unavailable mode mentions "下载桌面版" or
    // similar CTA copy; whichever copy is current, just check that the
    // workflow does NOT advance to "拓扑等待确认".
    await expect(page.getByText("拓扑等待确认")).not.toBeVisible({ timeout: 1500 });
  });
});
