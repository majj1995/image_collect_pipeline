import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

test("创建任务、拉取本地广告图片、人工筛选并下载可追溯 ZIP", async ({ page, request }) => {
  const externalRequests: string[] = [];
  page.on("request", (outbound) => {
    const hostname = new URL(outbound.url()).hostname;
    if (hostname !== "127.0.0.1") externalRequests.push(outbound.url());
  });

  const providerResponse = await request.get("/api/providers");
  expect(providerResponse.ok()).toBeTruthy();
  expect((await providerResponse.json()).items).toEqual([expect.objectContaining({ id: "fake", enabled: true })]);

  await page.goto("/");
  await expect(page).toHaveTitle("素材扩展台");
  await page.getByRole("button", { name: "新建采集任务" }).click();
  await page.getByLabel("任务名称", { exact: true }).fill(`E2E 音箱广告 ${Date.now()}`);
  await page.getByLabel("标签路径", { exact: true }).fill("电商快销>3C及电器>影音电器>音箱");
  await page.getByLabel("中文主查询词", { exact: true }).fill("音箱, 蓝牙音箱");
  await page.getByLabel("英文主查询词", { exact: true }).fill("speaker, bluetooth speaker");
  await page.getByLabel("中文素材风格", { exact: true }).fill("电商广告");
  await page.getByLabel("英文素材风格", { exact: true }).fill("ecommerce advertisement");
  await page.getByLabel("目标素材数", { exact: true }).fill("1");
  await page.getByLabel("候选素材数", { exact: true }).fill("1");
  await page.getByRole("button", { name: "创建并进入工作台" }).click();
  await expect(page).toHaveURL(/\/jobs\/[^/]+$/u);

  await page.getByRole("button", { name: "继续搜索" }).click();
  const thumbnail = page.locator('img[src^="/api/media/"]').first();
  await expect(thumbnail).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBeTruthy();
  await expect(thumbnail).toHaveAttribute("src", /^\/api\/media\/asset_[a-f0-9]+\/thumbnail$/u);

  await page.getByRole("button", { name: "选择音箱电商广告素材" }).click();
  await expect(page.getByText("已选 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出数据集" }).click();
  await expect(page.getByRole("heading", { name: "导出审计" })).toBeVisible();
  await page.getByLabel("我已确认这些素材仅用于内部研发，并理解授权状态未知").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 50_000 });
  await page.getByRole("button", { name: "生成 ZIP" }).click();
  const download = await downloadPromise;
  await expect(page.getByText("ZIP 已生成", { exact: true })).toBeVisible({ timeout: 15_000 });

  expect(download.suggestedFilename()).toMatch(/\.zip$/u);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(downloadPath!)));
  const entries = Object.keys(archive);
  const rootDirectory = entries[0]?.split("/", 1)[0];
  expect(rootDirectory).toMatch(/^[a-z0-9-]+_export_[a-f0-9]{24}$/u);
  expect(entries.every((name) => name.startsWith(`${rootDirectory}/`))).toBeTruthy();
  const files = entries.map((name) => name.slice(rootDirectory!.length + 1));
  expect(files).toContain("manifest.jsonl");
  expect(files.some((name) => /^images\/[^/]+\/[^/]+\.(?:jpg|png)$/u.test(name))).toBeTruthy();
  expect(files).toContain("checksums.sha256");
  expect(externalRequests).toEqual([]);

  await page.getByRole("button", { name: "关闭导出数据集" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const exportButton = page.getByRole("button", { name: "导出数据集", exact: true });
  await expect(exportButton).toBeVisible();
  const exportBounds = await exportButton.boundingBox();
  expect(exportBounds).not.toBeNull();
  expect(exportBounds!.x).toBeGreaterThanOrEqual(0);
  expect(exportBounds!.x + exportBounds!.width).toBeLessThanOrEqual(390);
});
