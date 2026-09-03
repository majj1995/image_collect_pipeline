// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestApp, mockApi } from "../helpers/client.js";

describe("采集任务页", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockApi.reset({
      jobs: [
        {
          id: "job-speaker",
          name: "音箱广告素材",
          taskType: "advertiser_product_taxonomy",
          exportMode: "internal_research",
          status: "reviewing",
          createdAt: "2026-08-28T08:00:00.000Z",
          updatedAt: "2026-08-29T09:30:00.000Z"
        }
      ]
    });
  });

  it("以开放式表格展示任务，并保持顶栏内容精简", async () => {
    render(<TestApp initialEntries={["/"]} />);

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("素材扩展台")).toBeVisible();
    expect(within(banner).getByRole("link", { name: "采集任务" })).toBeVisible();
    expect(within(banner).getByRole("link", { name: "提供方" })).toBeVisible();
    expect(await within(banner).findByText("本地服务已连接")).toBeVisible();

    const table = await screen.findByRole("table", { name: "采集任务列表" });
    expect(within(table).getByRole("columnheader", { name: "任务名称" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "候选数" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "已选数" })).toBeVisible();
    expect(within(table).getByRole("link", { name: "音箱广告素材" })).toHaveAttribute("href", "/jobs/job-speaker");
    expect(screen.queryByText(/总任务|今日新增|完成率/)).not.toBeInTheDocument();
  });

  it("在没有任务时保留表格结构和主操作", async () => {
    mockApi.reset({ jobs: [] });
    render(<TestApp initialEntries={["/"]} />);

    expect(await screen.findByRole("table", { name: "采集任务列表" })).toBeVisible();
    expect(screen.getByText("还没有采集任务")).toBeVisible();
    expect(screen.getByRole("button", { name: "新建采集任务" })).toBeEnabled();
  });
});
