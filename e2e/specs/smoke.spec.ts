import { expect, test } from "@playwright/test";

test("beginner request generates topology and export files", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "规划工作台" })).toBeVisible();
  await page.getByLabel("输入你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
  await page.getByRole("button", { name: /生成规划草案/ }).click();

  await expect(page.getByText("交换机 4")).toBeVisible();
  await expect(page.getByText("端系统 20")).toBeVisible();
  await expect(page.getByLabel("导出文件列表").getByText("network.ned", { exact: true })).toBeVisible();
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
});
