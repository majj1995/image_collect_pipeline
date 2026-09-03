// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "../../src/client/features/workbench/ExportDialog.js";
import type { ExportPreflight, JobDetail } from "../../src/client/api.js";
import { TestApiBoundary, mockApi } from "../helpers/client.js";

const internalJob: JobDetail = { id: "job-workbench", name: "音箱广告采集", taskType: "advertiser_product_taxonomy", exportMode: "internal_research", status: "reviewing", createdAt: "now", updatedAt: "now", labels: [] };
const strictJob: JobDetail = { ...internalJob, exportMode: "strict_compliance" };

function renderDialog(job: JobDetail, preflight: ExportPreflight) {
  mockApi.reset({ details: [job], preflight });
  render(<TestApiBoundary><ExportDialog job={job} open onClose={() => undefined} /></TestApiBoundary>);
}

function ExportHarness({ job }: { job: JobDetail }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开导出</button>
    <ExportDialog job={job} open={open} onClose={() => setOpen(false)} />
  </>;
}

describe("导出预检", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("内部研发仅确认指定候选，刷新预检后才能创建导出", async () => {
    const blocked = { selected: 3, uniqueAssets: 3, ready: 1, blockers: { ACKNOWLEDGEMENT_REQUIRED: ["candidate-1", "candidate-2"] }, warnings: {} };
    const ready = { ...blocked, ready: 3, blockers: {} };
    renderDialog(internalJob, blocked);
    mockApi.spies.createExport.mockResolvedValue({ id: "export-1", status: "ready", preflight: ready });
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeDisabled();
    const acknowledgement = await screen.findByLabelText("我已确认这些素材仅用于内部研发，并理解授权状态未知");
    mockApi.spies.getExportPreflight.mockResolvedValue(ready);
    await user.click(acknowledgement);
    expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "生成 ZIP" }));

    expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", { candidateIds: ["candidate-1", "candidate-2"], action: "acknowledge_rights", rightsAcknowledged: true });
    expect(mockApi.spies.getExportPreflight).toHaveBeenCalledTimes(2);
    expect(mockApi.spies.createExport).toHaveBeenCalledWith("job-workbench");
    expect(download).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("link", { name: "重新下载 ZIP" })).toHaveAttribute("href", "/api/exports/export-1/download");
  });

  it("打开后聚焦关闭按钮，循环约束焦点，Esc 关闭并恢复触发按钮焦点", async () => {
    const ready = { selected: 1, uniqueAssets: 1, ready: 1, blockers: {}, warnings: {} };
    mockApi.reset({ details: [internalJob], preflight: ready });
    const user = userEvent.setup();
    render(<TestApiBoundary><ExportHarness job={internalJob} /></TestApiBoundary>);

    const trigger = screen.getByRole("button", { name: "打开导出" });
    await user.click(trigger);
    const close = await screen.findByRole("button", { name: "关闭导出数据集" });
    expect(close).toHaveFocus();
    const generate = await screen.findByRole("button", { name: "生成 ZIP" });
    expect(generate).toBeEnabled();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "导出数据集" }), { key: "Tab", shiftKey: true });
    expect(generate).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "导出数据集" }), { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "导出数据集" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "导出数据集" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("生成前无条件刷新预检，新出现的阻塞会更新审计并中止创建", async () => {
    const ready = { selected: 1, uniqueAssets: 1, ready: 1, blockers: {}, warnings: {} };
    const staleBlocked = { selected: 1, uniqueAssets: 1, ready: 0, blockers: { PROVIDER_STORAGE_RIGHTS_REQUIRED: ["candidate-1"] }, warnings: {} };
    renderDialog(internalJob, ready);
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "生成 ZIP" })).toBeEnabled();
    mockApi.spies.getExportPreflight.mockResolvedValue(staleBlocked);

    await user.click(screen.getByRole("button", { name: "生成 ZIP" }));

    expect(await screen.findByText("预检仍有阻塞项，尚未创建 ZIP。")).toBeVisible();
    expect(screen.getByText("提供方合约阻塞").closest("div")).toHaveTextContent("1 条");
    expect(mockApi.spies.getExportPreflight).toHaveBeenCalledTimes(2);
    expect(mockApi.spies.createExport).not.toHaveBeenCalled();
  });

  it("提供方合约阻塞不能被确认绕过", async () => {
    renderDialog(internalJob, { selected: 2, uniqueAssets: 2, ready: 0, blockers: { ACKNOWLEDGEMENT_REQUIRED: ["candidate-1"], PROVIDER_STORAGE_RIGHTS_REQUIRED: ["candidate-2"] }, warnings: {} });
    const user = userEvent.setup();

    await screen.findByText("提供方合约阻塞");
    await user.click(screen.getByLabelText("我已确认这些素材仅用于内部研发，并理解授权状态未知"));
    expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeDisabled();
    expect(screen.getByText(/不能通过内部研发确认绕过/)).toBeVisible();
  });

  it("严格合规模式没有确认绕过入口", async () => {
    renderDialog(strictJob, { selected: 1, uniqueAssets: 1, ready: 0, blockers: { RIGHTS_UNVERIFIED: ["candidate-1"] }, warnings: {} });

    expect(await screen.findByText("严格合规")).toBeVisible();
    expect(screen.queryByLabelText("我已确认这些素材仅用于内部研发，并理解授权状态未知")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成 ZIP" })).toBeDisabled();
  });

  it("只在生成中轮询，并仅自动下载一次且保留手动重试地址", async () => {
    vi.useFakeTimers();
    const readyPreflight = { selected: 1, uniqueAssets: 1, ready: 1, blockers: {}, warnings: {} };
    renderDialog(internalJob, readyPreflight);
    mockApi.spies.createExport.mockResolvedValue({ id: "export-9", status: "generating", preflight: readyPreflight });
    mockApi.spies.getExport.mockResolvedValueOnce({ id: "export-9", jobId: "job-workbench", status: "generating", preflight: readyPreflight, errorCode: null, zipSha256: null })
      .mockResolvedValueOnce({ id: "export-9", jobId: "job-workbench", status: "ready", preflight: readyPreflight, errorCode: null, zipSha256: "abc" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成 ZIP" })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });

    expect(mockApi.spies.getExport).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "重新下载 ZIP" })).toHaveAttribute("href", "/api/exports/export-9/download");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.getExport).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
