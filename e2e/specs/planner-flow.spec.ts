import { expect, test } from "@playwright/test";
import { enableTestRuntime } from "../fixtures/test-runtime";

test.describe("planner flow", () => {
  test.beforeEach(async ({ page }) => {
    await enableTestRuntime(page);
  });

  test("advances through all stages and exposes planner task panel", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("输入你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
    await page.getByRole("button", { name: "生成规划草案" }).click();
    await expect(page.getByText("拓扑等待确认")).toBeVisible();

    await page.getByRole("button", { name: "确认并继续" }).click();
    await expect(page.getByText("时间同步等待确认")).toBeVisible();
    await page.getByRole("button", { name: "确认并继续" }).click();
    await expect(page.getByText("流量规划等待确认")).toBeVisible();
    await page.getByRole("button", { name: "确认并继续" }).click();
    await expect(page.getByText("模拟仿真等待确认")).toBeVisible();

    await page.getByRole("tab", { name: "导出文件" }).click();
    await expect(page.getByLabel("规划任务")).toBeVisible();
  });
});
