// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, LabelTarget, ProviderRunSummary, ProviderStatus } from "../../src/shared/contracts.js";
import { WorkbenchPage } from "../../src/client/pages/WorkbenchPage.js";
import { TestApiBoundary, WorkbenchTestApp, mockApi } from "../helpers/client.js";

const labels: LabelTarget[] = [
  { id: "label-a", jobId: "job-workbench", path: ["3C", "影音电器", "音箱"], product: "音箱", aliases: [], styles: ["电商广告"], requiredTerms: [], excludedTerms: [], targetCount: 30, candidateCount: 100, selectedCount: 0 },
  { id: "label-b", jobId: "job-workbench", path: ["3C", "影音电器", "耳机"], product: "耳机", aliases: [], styles: ["电商广告"], requiredTerms: [], excludedTerms: [], targetCount: 30, candidateCount: 100, selectedCount: 0 },
  { id: "label-c", jobId: "job-workbench", path: ["家电", "厨房电器", "冰箱"], product: "冰箱", aliases: [], styles: ["电商广告"], requiredTerms: [], excludedTerms: [], targetCount: 30, candidateCount: 100, selectedCount: 0 }
];

const candidate = (index: number, overrides: Partial<Candidate> = {}): Candidate => ({
  id: `candidate-${index}`,
  jobId: "job-workbench",
  provider: index % 2 ? "openverse" : "brave",
  imageUrl: `https://remote.example/image-${index}.jpg?token=secret`,
  landingPageUrl: `https://shop.example/item-${index}?productId=${index}&token=secret#private`,
  title: `素材 ${index}`,
  pipelineState: "processed",
  rightsStatus: index % 2 ? "cc0" : "unknown",
  assetId: `asset-${index}`,
  width: 1000 + index,
  height: 800 + index,
  mimeType: "image/jpeg",
  discoveryLabelIds: ["label-a"],
  reviewState: "unreviewed",
  labelIds: [],
  primaryLabelId: null,
  provenance: [],
  ...overrides
});

const baseCandidates: Candidate[] = [
  candidate(1, { width: 1600, height: 1200, nearDuplicateGroup: "dup-a" }),
  candidate(2, { width: 800, height: 600, nearDuplicateGroup: "dup-a" }),
  candidate(3),
  candidate(4),
  candidate(5, { pipelineState: "fetching", assetId: null }),
  candidate(6, { pipelineState: "invalid", assetId: null, pipelineError: "INVALID_IMAGE" }),
  candidate(7, { pipelineState: "quarantined", assetId: null, pipelineError: "REMOTE_ADDRESS_BLOCKED" }),
  candidate(8, { discoveryLabelIds: ["label-b"] })
];

const job = {
  id: "job-workbench",
  name: "音箱广告采集",
  taskType: "advertiser_product_taxonomy" as const,
  exportMode: "internal_research" as const,
  status: "reviewing" as const,
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-29T09:00:00.000Z",
  labels
};

const selectableProviders: ProviderStatus[] = [
  { id: "openverse", displayName: "Openverse", configured: false, enabled: true, rightsPolicy: "open", maxResults: 200, credentialVariables: [], credentialMode: "none", sourceCategory: "general", freeTier: "匿名公开 API", docsUrl: "https://docs.openverse.org/api/guides/", defaultSelected: true },
  { id: "bing_ads", displayName: "Microsoft Bing Ad Library", configured: false, enabled: true, rightsPolicy: "discovery_only", maxResults: 100, credentialVariables: [], credentialMode: "none", sourceCategory: "ad_library", freeTier: "匿名公开 API", docsUrl: "https://learn.microsoft.com/en-us/advertising/guides/ad-library-api?view=bingads-13", defaultSelected: true },
  { id: "smithsonian", displayName: "Smithsonian Open Access", configured: false, enabled: true, rightsPolicy: "open", maxResults: 100, credentialVariables: ["SMITHSONIAN_API_KEY"], credentialMode: "optional", sourceCategory: "culture", freeTier: "DEMO_KEY", docsUrl: "https://edan.si.edu/openaccess/apidocs/", defaultSelected: false },
  { id: "brave", displayName: "Brave", configured: true, enabled: true, rightsPolicy: "discovery_only", maxResults: 100, credentialVariables: ["BRAVE_API_KEY"], credentialMode: "required", sourceCategory: "general", freeTier: "免费开发者 API Key", docsUrl: "https://api-dashboard.search.brave.com/app/documentation", defaultSelected: false }
];
const jobWorkbenchProviderSelectionKey = "material-expansion:provider-selection:v1:job-workbench";
const jobAProviderSelectionKey = "material-expansion:provider-selection:v1:job-a";
const jobBProviderSelectionKey = "material-expansion:provider-selection:v1:job-b";

function reset(candidates = baseCandidates, providerRuns: ProviderRunSummary[] = []) {
  mockApi.reset({ details: [job], candidates, providerRuns });
}

function reviewState(candidateId: string, state: "unreviewed" | "selected" | "rejected") {
  return { candidateId, reviewState: state, labelIds: state === "selected" ? ["label-a"] : [], primaryLabelId: state === "selected" ? "label-a" : null, rightsAcknowledged: false, rightsBasis: "unknown" as const, rightsEvidence: null, warningOverrides: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function RouteSwitchControls({ onJobBLayout }: { onJobBLayout?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  useLayoutEffect(() => {
    if (location.pathname === "/jobs/job-b") onJobBLayout?.();
  }, [location.pathname, onJobBLayout]);
  return <>
    <button type="button" onClick={() => navigate("/jobs/job-a")}>切换到任务 A</button>
    <button type="button" onClick={() => navigate("/jobs/job-b")}>切换到任务 B</button>
    <Routes><Route path="/jobs/:jobId" element={<WorkbenchPage />} /></Routes>
  </>;
}

function RouteSwitchWorkbench({ onJobBLayout }: { onJobBLayout?: () => void } = {}) {
  return <MemoryRouter initialEntries={["/jobs/job-a"]}>
    <TestApiBoundary><RouteSwitchControls onJobBLayout={onJobBLayout} /></TestApiBoundary>
  </MemoryRouter>;
}

function controllableDesktopQuery(initialMatches = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    matches: initialMatches,
    media: "(min-width: 900px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); }),
    dispatchEvent: vi.fn(() => true)
  } as unknown as MediaQueryList;
  return {
    mediaQuery,
    matchMedia: vi.fn(() => mediaQuery),
    change(matches: boolean) {
      Object.defineProperty(mediaQuery, "matches", { configurable: true, value: matches });
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    }
  };
}

describe("图片筛选工作台", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  beforeEach(() => { window.localStorage.clear(); reset(); });

  it("按发现标签和真实素材属性筛选，并只加载本地缩略图", async () => {
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const workbench = await screen.findByRole("main", { name: "音箱广告采集工作台" });
    expect(within(workbench).getByRole("navigation", { name: "分类队列" })).toBeVisible();
    expect(within(workbench).getByRole("region", { name: "候选素材画廊" })).toBeVisible();
    const image = screen.getByRole("img", { name: "候选素材 1" });
    expect(image).toHaveAttribute("src", "/api/media/asset-1/thumbnail");
    expect(image).not.toHaveAttribute("src", expect.stringContaining("remote.example"));
    expect(screen.queryByText("素材 8")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /耳机/ }));
    expect(await screen.findByText("素材 8")).toBeVisible();
    expect(screen.queryByText("素材 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /音箱/ }));
    await user.selectOptions(screen.getByLabelText("来源"), "brave");
    expect(screen.getByText("素材 4")).toBeVisible();
    expect(screen.queryByText("素材 3")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("授权类型"), "unknown");
    expect(screen.getByText("素材 2")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("尺寸"), "large");
    expect(screen.queryByText("素材 2")).not.toBeInTheDocument();
  });

  it("按候选的完整溯源提供方并集筛选，而非只看规范化主提供方", async () => {
    const provenanceCandidate = candidate(11, {
      provider: "openverse",
      title: "多来源音箱",
      provenance: [{
        hitId: "hit-brave", queryRunId: "run-brave", provider: "brave", variantName: "exact_ad",
        query: "音箱 电商海报", page: 1, imageUrl: "https://images.example.test/speaker.jpg",
        landingPageUrl: null, title: "多来源音箱", creator: null, licenseName: null, licenseUrl: null,
        sourceProvider: "Brave Images", source: "Brave Images", rightsStatus: "unknown"
      }]
    });
    reset([provenanceCandidate]);
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("多来源音箱");

    await user.selectOptions(screen.getByLabelText("来源"), "brave");

    expect(screen.getByText("多来源音箱")).toBeVisible();
  });

  it("在卡片、来源筛选和溯源详情统一显示后端提供方名称", async () => {
    const bingProvider: ProviderStatus = {
      id: "bing_ads", displayName: "Microsoft Bing Ad Library", configured: false, enabled: true,
      rightsPolicy: "discovery_only", maxResults: 100, credentialVariables: [], credentialMode: "none",
      sourceCategory: "ad_library", freeTier: "匿名公开 API", docsUrl: "https://learn.microsoft.com/advertising", defaultSelected: true
    };
    const bingCandidate = candidate(12, {
      provider: "bing_ads",
      title: "Bing 音箱广告",
      provenance: [{
        hitId: "hit-bing", queryRunId: "run-bing", provider: "bing_ads", variantName: "exact_ad",
        query: "音箱 电商广告", page: 1, imageUrl: "https://images.example.test/bing.jpg",
        landingPageUrl: null, title: "Bing 音箱广告", creator: null, licenseName: null, licenseUrl: null,
        sourceProvider: "Microsoft Bing Ad Library", source: "ad-12", rightsStatus: "unknown"
      }]
    });
    mockApi.reset({ details: [job], candidates: [bingCandidate], providers: [bingProvider] });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    await screen.findByText("Bing 音箱广告");
    expect(screen.getByText(/Microsoft Bing Ad Library · 授权未知/)).toBeVisible();
    expect(within(screen.getByLabelText("来源")).getByRole("option", { name: "Microsoft Bing Ad Library" })).toHaveValue("bing_ads");
    await user.click(screen.getByRole("button", { name: "查看Bing 音箱广告 详情" }));
    const drawer = screen.getByRole("complementary", { name: "素材溯源与信息" });
    expect(within(drawer).getAllByText("Microsoft Bing Ad Library")).toHaveLength(2);
    expect(screen.queryByText("bing_ads")).not.toBeInTheDocument();
  });

  it("在继续搜索请求完成前同步锁定按钮并抑制重复提交", async () => {
    const start = deferred<{ status: "collecting" }>();
    mockApi.spies.startSearch.mockImplementation(() => start.promise);
    render(<WorkbenchTestApp />);
    const button = await screen.findByRole("button", { name: "继续搜索" });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockApi.spies.startSearch).toHaveBeenCalledTimes(1);
    expect(mockApi.spies.startSearch).toHaveBeenCalledWith("job-workbench", {
      providerIds: ["openverse"], retryFailedProviderIds: []
    });
    expect(button).toBeDisabled();
    await act(async () => { start.resolve({ status: "collecting" }); await Promise.resolve(); });
  });

  it("继续搜索不会隐式重试已选来源中的终止失败任务", async () => {
    reset([], [{
      id: "run-openverse-failed", jobId: "job-workbench", labelId: "label-a", providerId: "openverse",
      variantName: "exact_ad", query: "speaker ecommerce advertisement", status: "failed", retryable: false,
      errorSummary: "旧版本请求失败。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 20, hitCount: 0
    }]);
    render(<WorkbenchTestApp />);

    fireEvent.click(await screen.findByRole("button", { name: "继续搜索" }));

    expect(mockApi.spies.startSearch).toHaveBeenCalledWith("job-workbench", {
      providerIds: ["openverse"], retryFailedProviderIds: []
    });
  });

  it("按免费访问门槛分组选择来源，并只提交当前勾选且可用的渠道", async () => {
    const providers: ProviderStatus[] = [
      { id: "openverse", displayName: "Openverse", configured: false, enabled: true, rightsPolicy: "open", maxResults: 200, credentialVariables: [], credentialMode: "none", sourceCategory: "general", freeTier: "匿名公开 API", docsUrl: "https://docs.openverse.org/api/guides/", defaultSelected: true },
      { id: "bing_ads", displayName: "Microsoft Bing Ad Library", configured: false, enabled: true, rightsPolicy: "discovery_only", maxResults: 100, credentialVariables: [], credentialMode: "none", sourceCategory: "ad_library", freeTier: "匿名公开 API", docsUrl: "https://learn.microsoft.com/en-us/advertising/guides/ad-library-api?view=bingads-13", defaultSelected: true },
      { id: "smithsonian", displayName: "Smithsonian Open Access", configured: false, enabled: true, rightsPolicy: "open", maxResults: 100, credentialVariables: ["SMITHSONIAN_API_KEY"], credentialMode: "optional", sourceCategory: "culture", freeTier: "DEMO_KEY", docsUrl: "https://edan.si.edu/openaccess/apidocs/", defaultSelected: false },
      { id: "pexels", displayName: "Pexels", configured: false, enabled: false, rightsPolicy: "discovery_only", maxResults: 80, credentialVariables: ["PEXELS_API_KEY"], credentialMode: "required", sourceCategory: "general", freeTier: "免费开发者 API Key", docsUrl: "https://www.pexels.com/api/documentation/", defaultSelected: false },
      { id: "tiktok_ads", displayName: "TikTok Commercial Content", configured: false, enabled: false, rightsPolicy: "discovery_only", maxResults: 10, credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], credentialMode: "approval", sourceCategory: "ad_library", freeTier: "免费申请审批", docsUrl: "https://developers.tiktok.com/products/commercial-content-api", defaultSelected: false }
    ];
    mockApi.reset({ details: [job], candidates: baseCandidates, providers });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const pickerButton = await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" });
    await user.click(pickerButton);
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(picker).getByRole("group", { name: "免 Key 渠道" })).toBeVisible();
    expect(within(picker).getByRole("group", { name: "免费 Key 或账号" })).toBeVisible();
    expect(within(picker).getByRole("group", { name: "免费申请或审批" })).toBeVisible();
    expect(within(picker).getByRole("checkbox", { name: /Pexels/ })).toBeDisabled();
    expect(within(picker).getByRole("checkbox", { name: /TikTok Commercial Content/ })).toBeDisabled();

    await user.click(within(picker).getByRole("button", { name: "仅选免 Key" }));
    expect(within(picker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeChecked();
    await user.click(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(picker).getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "继续搜索" }));

    expect(mockApi.spies.startSearch).toHaveBeenCalledWith("job-workbench", {
      providerIds: ["openverse", "smithsonian"], retryFailedProviderIds: []
    });
  });

  it("初次渲染读取任务持久来源但不回写，后续改选写入精确任务键和值", async () => {
    window.localStorage.setItem(jobWorkbenchProviderSelectionKey, JSON.stringify(["smithsonian"]));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const pickerButton = await screen.findByRole("button", { name: "选择搜索来源，已选 1 个" });
    expect(setItem).not.toHaveBeenCalled();
    await user.click(pickerButton);
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(picker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeChecked();
    await user.click(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenLastCalledWith(
      jobWorkbenchProviderSelectionKey,
      JSON.stringify(["bing_ads", "smithsonian"])
    );
  });

  it("持久值损坏时使用全部可用来源作为无默认配置的回退", async () => {
    window.localStorage.setItem(jobWorkbenchProviderSelectionKey, "{not-json");
    const providersWithoutDefaults = selectableProviders.map((provider, index) => ({
      ...provider,
      enabled: index < 2,
      defaultSelected: false
    }));
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: providersWithoutDefaults });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(picker).getByRole("checkbox", { name: /Openverse/ })).toBeChecked();
    expect(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ })).toBeChecked();
    expect(within(picker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeDisabled();
    expect(within(picker).getByRole("checkbox", { name: /Brave/ })).toBeDisabled();
  });

  it("浏览器存储读写抛错时仍回退默认来源并允许本次改选", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage blocked"); });
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const pickerButton = await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" });
    getItem.mockRestore();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage full"); });
    await user.click(pickerButton);
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));

    expect(setItem).toHaveBeenCalledWith(jobWorkbenchProviderSelectionKey, JSON.stringify(["openverse"]));
    expect(screen.getByRole("button", { name: "选择搜索来源，已选 1 个" })).toBeVisible();
  });

  it("用户改选来源后，重载同一任务会恢复该选择且不会被初始空状态覆盖", async () => {
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders });
    const user = userEvent.setup();
    const firstView = render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const firstPicker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ }));
    firstView.unmount();

    mockApi.spies.startSearch.mockClear();
    render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const restoredPicker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(restoredPicker).getByRole("checkbox", { name: /Openverse/ })).toBeChecked();
    expect(within(restoredPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ })).not.toBeChecked();
    expect(within(restoredPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeChecked();
    await user.click(within(restoredPicker).getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "继续搜索" }));

    expect(mockApi.spies.startSearch).toHaveBeenCalledWith("job-workbench", {
      providerIds: ["openverse", "smithsonian"], retryFailedProviderIds: []
    });
  });

  it("恢复来源时会剔除已禁用和已删除渠道，同时保留仍有效的持久选择", async () => {
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders });
    const user = userEvent.setup();
    const firstView = render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const firstPicker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Openverse/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Brave/ }));
    firstView.unmount();

    const currentlyAvailable = selectableProviders
      .filter((provider) => provider.id !== "brave")
      .map((provider) => provider.id === "smithsonian" ? { ...provider, enabled: false } : provider);
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: currentlyAvailable });
    render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 1 个" }));
    const restoredPicker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(restoredPicker).getByRole("checkbox", { name: /Openverse/ })).not.toBeChecked();
    expect(within(restoredPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ })).toBeChecked();
    expect(within(restoredPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeDisabled();
  });

  it("持久来源全部失效时回退到当前默认来源", async () => {
    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders });
    const user = userEvent.setup();
    const firstView = render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const firstPicker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Openverse/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ }));
    await user.click(within(firstPicker).getByRole("checkbox", { name: /Brave/ }));
    firstView.unmount();

    mockApi.reset({ details: [job], candidates: baseCandidates, providers: selectableProviders.slice(0, 2) });
    render(<WorkbenchTestApp />);

    expect(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" })).toBeVisible();
  });

  it("不同任务各自保存来源选择，不会把任务 A 的选择带入任务 B", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    mockApi.reset({ details: [jobA, jobB], candidates: [], providers: selectableProviders });
    const user = userEvent.setup();
    render(<RouteSwitchWorkbench />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(picker).getByRole("checkbox", { name: /Openverse/ }));
    await user.click(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(picker).getByRole("checkbox", { name: /Smithsonian Open Access/ }));
    await user.click(within(picker).getByRole("button", { name: "完成" }));

    await user.click(screen.getByRole("button", { name: "切换到任务 B" }));

    expect(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const jobBPicker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(jobBPicker).getByRole("checkbox", { name: /Openverse/ })).toBeChecked();
    expect(within(jobBPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ })).toBeChecked();
    expect(within(jobBPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).not.toBeChecked();
    await user.click(within(jobBPicker).getByRole("checkbox", { name: /Openverse/ }));
    await user.click(within(jobBPicker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(jobBPicker).getByRole("checkbox", { name: /Brave/ }));
    await user.click(within(jobBPicker).getByRole("button", { name: "完成" }));
    expect(window.localStorage.getItem(jobAProviderSelectionKey)).toBe(JSON.stringify(["smithsonian"]));
    expect(window.localStorage.getItem(jobBProviderSelectionKey)).toBe(JSON.stringify(["brave"]));

    await user.click(screen.getByRole("button", { name: "切换到任务 A" }));

    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 1 个" }));
    const restoredJobAPicker = screen.getByRole("dialog", { name: "搜索来源" });
    expect(within(restoredJobAPicker).getByRole("checkbox", { name: /Openverse/ })).not.toBeChecked();
    expect(within(restoredJobAPicker).getByRole("checkbox", { name: /Smithsonian Open Access/ })).toBeChecked();
  });

  it("任务切换提交到被动 effect 前会隐藏旧来源选择，不能把 A 的状态写入 B", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    const pendingJobB = deferred<typeof jobB>();
    mockApi.reset({ details: [jobA, jobB], candidates: [], providers: selectableProviders });
    mockApi.spies.getJob.mockImplementation((requestedJobId) => requestedJobId === "job-b"
      ? pendingJobB.promise
      : Promise.resolve(jobA));
    const interactionDuringJobBLayout = vi.fn(() => {
      const staleCheckbox = screen.queryByRole("checkbox", { name: /Openverse/ });
      if (staleCheckbox instanceof HTMLInputElement) staleCheckbox.click();
    });
    const user = userEvent.setup();
    render(<RouteSwitchWorkbench onJobBLayout={interactionDuringJobBLayout} />);
    await user.click(await screen.findByRole("button", { name: "选择搜索来源，已选 2 个" }));
    const picker = screen.getByRole("dialog", { name: "搜索来源" });
    await user.click(within(picker).getByRole("checkbox", { name: /Openverse/ }));
    await user.click(within(picker).getByRole("checkbox", { name: /Microsoft Bing Ad Library/ }));
    await user.click(within(picker).getByRole("checkbox", { name: /Smithsonian Open Access/ }));
    expect(window.localStorage.getItem(jobAProviderSelectionKey)).toBe(JSON.stringify(["smithsonian"]));
    expect(window.localStorage.getItem(jobBProviderSelectionKey)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换到任务 B" }));

    expect(interactionDuringJobBLayout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(jobAProviderSelectionKey)).toBe(JSON.stringify(["smithsonian"]));
    expect(window.localStorage.getItem(jobBProviderSelectionKey)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("正在打开素材工作台");
    await act(async () => { pendingJobB.resolve(jobB); await Promise.resolve(); });
    expect(await screen.findByRole("main", { name: "任务 B工作台" })).toBeVisible();
    expect(window.localStorage.getItem(jobBProviderSelectionKey)).toBeNull();
  });

  it("继续搜索的慢提交遇到空轮询后仍会立即加载最终结果并解锁", async () => {
    vi.useFakeTimers();
    const start = deferred<{ status: "collecting" }>();
    mockApi.spies.startSearch.mockImplementation(() => start.promise);
    const emptyPage = { items: [], nextCursor: null, labelProgress: [], providerRuns: [] };
    mockApi.spies.listCandidates
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce({ ...emptyPage, items: [candidate(9)] });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const button = screen.getByRole("button", { name: "继续搜索" });

    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    await act(async () => {
      start.resolve({ status: "collecting" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    expect(screen.getByText("素材 9")).toBeVisible();
    expect(button).toBeEnabled();
  });

  it("继续搜索请求失败时回滚同步锁定并允许再次尝试", async () => {
    mockApi.spies.startSearch.mockRejectedValueOnce(new Error("offline"));
    render(<WorkbenchTestApp />);
    const button = await screen.findByRole("button", { name: "继续搜索" });

    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法继续搜索");
    expect(button).toBeEnabled();
  });

  it("继续搜索已穷尽时明确提示调整条件且不启动假轮询", async () => {
    vi.useFakeTimers();
    reset(baseCandidates.filter((item) => item.pipelineState !== "fetching"));
    mockApi.spies.startSearch.mockResolvedValueOnce({ status: "exhausted" });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const button = screen.getByRole("button", { name: "继续搜索" });
    const callsBeforeSearch = mockApi.spies.listCandidates.mock.calls.length;

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByText("当前已选来源和查询条件已无更多结果，请增加搜索来源或调整查询条件。")).toBeVisible();
    expect(button).toBeEnabled();
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(callsBeforeSearch);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(callsBeforeSearch);
  });

  it("继续搜索异步完成但全量候选 ID 未增加时提示本轮无新素材并停止轮询", async () => {
    vi.useFakeTimers();
    const settledCandidates = baseCandidates.filter((item) => item.pipelineState !== "fetching");
    const running: ProviderRunSummary = {
      id: "run-zero-addition", jobId: "job-workbench", labelId: "label-a", providerId: "openverse",
      variantName: "base", query: "音箱 广告", status: "running", retryable: false, errorSummary: null,
      createdAt: "now", startedAt: "now", completedAt: null, durationMs: null, hitCount: 0
    };
    const completed: ProviderRunSummary = {
      ...running, status: "completed", completedAt: "later", durationMs: 20
    };
    reset(settledCandidates);
    let authoritativeRound = 0;
    mockApi.spies.listCandidates.mockImplementation((_jobId, cursor) => {
      if (cursor === undefined) authoritativeRound += 1;
      const providerRuns = authoritativeRound === 1 ? [] : authoritativeRound === 2 ? [running] : [completed];
      if (cursor === undefined) {
        return Promise.resolve({ items: settledCandidates.slice(0, 3), nextCursor: 3, labelProgress: [], providerRuns });
      }
      return Promise.resolve({ items: settledCandidates.slice(3), nextCursor: null, labelProgress: [], providerRuns });
    });
    mockApi.spies.startSearch.mockResolvedValueOnce({ status: "collecting" });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const button = screen.getByRole("button", { name: "继续搜索" });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(4);
    expect(button).toBeDisabled();
    expect(screen.queryByText("本轮未新增素材；已选来源或查询可能已耗尽，请增加来源或调整条件。")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(6);
    expect(screen.getByText("本轮未新增素材；已选来源或查询可能已耗尽，请增加来源或调整条件。")).toBeVisible();
    expect(button).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(6);
  });

  it("选择、拒绝、查看溯源并仅看未审核，分类任务始终提交当前叶子", async () => {
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");

    await user.click(screen.getByRole("button", { name: "选择素材 1" }));
    await user.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    await user.click(screen.getByRole("button", { name: "查看素材 1 详情" }));

    expect(screen.getByRole("complementary", { name: "素材溯源与信息" })).toBeVisible();
    expect(screen.getByText("来源与授权")).toBeVisible();
    expect(screen.getByText("已选 1")).toBeVisible();
    expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "select", labelIds: ["label-a"], primaryLabelId: "label-a"
    });

    await user.click(screen.getByLabelText("仅看未审核"));
    expect(screen.queryByText("素材 1")).not.toBeInTheDocument();
    expect(screen.queryByText("素材 3")).not.toBeInTheDocument();
  });

  it("支持 Shift 范围审核、批量拒绝、重复组保留最高分辨率和兄弟标签移动", async () => {
    reset([...baseCandidates, candidate(29, {
      nearDuplicateGroup: "dup-a",
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: "NETWORK"
    })]);
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");

    await user.click(screen.getByRole("button", { name: "展开重复素材 2 项" }));
    await user.click(screen.getByRole("button", { name: "选择素材 1" }));
    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }), { shiftKey: true });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", expect.objectContaining({
      candidateIds: ["candidate-1", "candidate-2", "candidate-3"], action: "select"
    })));

    await user.click(screen.getByLabelText("勾选素材 3"));
    await user.click(screen.getByLabelText("勾选素材 4"));
    await user.click(screen.getByRole("button", { name: "批量拒绝" }));
    expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", { candidateIds: ["candidate-3", "candidate-4"], action: "reject" });

    await user.click(screen.getByRole("button", { name: "保留重复组最高分辨率" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", {
      candidateIds: ["candidate-1", "candidate-2"], action: "keep_highest_resolution", primaryCandidateId: "candidate-1", labelIds: ["label-a"], primaryLabelId: "label-a"
    }));

    await user.click(screen.getByRole("button", { name: "查看素材 1 详情" }));
    await user.selectOptions(screen.getByLabelText("移动到标签"), "label-b");
    expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", { candidateIds: ["candidate-1"], action: "move_label", labelIds: ["label-b"], primaryLabelId: "label-b" });
  });

  it("串行化同一候选的失败审核，旧回滚不会覆盖后续操作", async () => {
    const first = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    const second = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    mockApi.spies.review.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));

    await act(async () => { first.reject(new Error("write failed")); await Promise.resolve(); });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve({ items: [reviewState("candidate-3", "rejected")] }); await Promise.resolve(); });

    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    expect(mockApi.spies.listCandidates.mock.calls.length).toBeGreaterThan(1);
  });

  it("忽略审核期间启动并延迟返回的旧轮询结果", async () => {
    vi.useFakeTimers();
    const running: ProviderRunSummary[] = [{ id: "run-race", jobId: "job-workbench", labelId: "label-a", providerId: "openverse", variantName: "base", query: "音箱 广告", status: "running", errorSummary: null, createdAt: "now", startedAt: "now", completedAt: null, durationMs: null, hitCount: 1 }];
    reset(baseCandidates, running);
    const stalePoll = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    mockApi.spies.listCandidates.mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: running }).mockImplementationOnce(() => stalePoll.promise);
    mockApi.spies.review.mockResolvedValueOnce({ items: [reviewState("candidate-3", "selected")] }).mockResolvedValueOnce({ items: [reviewState("candidate-3", "rejected")] });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");

    await act(async () => { stalePoll.resolve({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: running }); await Promise.resolve(); });
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
  });

  it("审核并发使轮询快照失效时会继续刷新直到新候选可见", async () => {
    vi.useFakeTimers();
    const running: ProviderRunSummary[] = [{
      id: "run-review-poll-race", jobId: "job-workbench", labelId: "label-a", providerId: "openverse",
      variantName: "base", query: "音箱 广告", status: "running", errorSummary: null, createdAt: "now",
      startedAt: "now", completedAt: null, durationMs: null, hitCount: 1
    }];
    const stalePoll = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const review = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    const settledCandidates = baseCandidates.filter((item) => item.pipelineState !== "fetching");
    const reviewed = settledCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
      : item);
    const refreshed = [...reviewed, candidate(30)];
    reset(settledCandidates, running);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: settledCandidates, nextCursor: null, labelProgress: [], providerRuns: running })
      .mockImplementationOnce(() => stalePoll.promise)
      .mockResolvedValueOnce({ items: refreshed, nextCursor: null, labelProgress: [], providerRuns: [] });
    mockApi.spies.review.mockImplementationOnce(() => review.promise);
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => {
      stalePoll.resolve({ items: [...settledCandidates, candidate(30)], nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");
    expect(screen.queryByText("素材 30")).not.toBeInTheDocument();
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    await act(async () => { review.resolve({ items: [reviewState("candidate-3", "selected")] }); await Promise.resolve(); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    expect(screen.getByText("素材 30")).toBeVisible();
  });

  it("同候选后续成功时丢弃审核期间返回的旧强制快照", async () => {
    const reconciliation = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const refreshed = baseCandidates.map((item) => item.id === "candidate-4"
      ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
      : item);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockImplementationOnce(() => reconciliation.promise);
    mockApi.spies.review
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({ items: [reviewState("candidate-3", "rejected")] });
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");

    await act(async () => {
      reconciliation.resolve({ items: refreshed, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "unreviewed");
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(2));
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("审核响应丢失后的权威对账水位可由更新普通加载接管并保留后续覆盖", async () => {
    const forced = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const ordinary = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const laterReview = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    const committed = baseCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
      : item);
    const changedAfterReconciliation = committed.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "rejected" as const, labelIds: [], primaryLabelId: null }
      : item.id === "candidate-4"
        ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
        : item);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockImplementationOnce(() => forced.promise)
      .mockImplementationOnce(() => ordinary.promise)
      .mockResolvedValueOnce({ items: changedAfterReconciliation, nextCursor: null, labelProgress: [], providerRuns: [] });
    mockApi.spies.review
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockImplementationOnce(() => laterReview.promise);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "选择素材 4" }));
    await act(async () => {
      forced.resolve({ items: committed, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");
    await act(async () => {
      ordinary.resolve({ items: committed, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected"));
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");

    await act(async () => { laterReview.resolve({ items: [reviewState("candidate-4", "selected")] }); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected"));
  });

  it("最新权威加载失败时保留对账水位和错误 patch，后续加载仍可完成对账", async () => {
    vi.useFakeTimers();
    const retry = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const laterReview = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    const authoritative = baseCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "rejected" as const, labelIds: [], primaryLabelId: null }
      : item);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockRejectedValueOnce(new Error("reconciliation unavailable"))
      .mockImplementationOnce(() => retry.promise)
      .mockResolvedValueOnce({ items: authoritative.map((item) => item.id === "candidate-4"
        ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
        : item), nextCursor: null, labelProgress: [], providerRuns: [] });
    mockApi.spies.review
      .mockRejectedValueOnce(new Error("write outcome unknown"))
      .mockImplementationOnce(() => laterReview.promise);
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("素材 3")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("审核状态重新同步失败");
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "选择素材 4" }));
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.spies.review).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve({ items: authoritative, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");
    await act(async () => { laterReview.resolve({ items: [reviewState("candidate-4", "selected")] }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");
  });

  it("权威加载期间出现新审核时丢弃旧快照并在队列稳定后自动重新对账", async () => {
    vi.useFakeTimers();
    const firstReconciliation = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const stalePause = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    const reconciled = baseCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "rejected" as const, labelIds: [], primaryLabelId: null }
      : item.id === "candidate-4"
        ? { ...item, reviewState: "selected" as const, labelIds: ["label-a"], primaryLabelId: "label-a" }
        : item);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockImplementationOnce(() => firstReconciliation.promise)
      .mockImplementationOnce(() => stalePause.promise)
      .mockResolvedValueOnce({ items: reconciled, nextCursor: null, labelProgress: [], providerRuns: [] });
    mockApi.spies.review
      .mockRejectedValueOnce(new Error("select committed but response was lost"))
      .mockResolvedValueOnce({ items: [reviewState("candidate-4", "selected")] });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("素材 3")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "选择素材 4" }));
    await act(async () => {
      firstReconciliation.resolve({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockApi.spies.review).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");

    await act(async () => {
      stalePause.resolve({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    expect(screen.getByTestId("candidate-candidate-4")).toHaveAttribute("data-review-state", "selected");
  });

  it("同候选较新的完整成功响应移除旧未知 patch 并恢复活跃轮询", async () => {
    vi.useFakeTimers();
    const running: ProviderRunSummary[] = [{
      id: "run-supersession", jobId: "job-workbench", labelId: "label-a", providerId: "openverse", variantName: "base",
      query: "音箱 广告", status: "running", errorSummary: null, createdAt: "now", startedAt: "now",
      completedAt: null, durationMs: null, hitCount: 1
    }];
    const rejected = baseCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "rejected" as const, labelIds: [], primaryLabelId: null }
      : item);
    reset(baseCandidates, running);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: running })
      .mockRejectedValueOnce(new Error("reconciliation unavailable"))
      .mockResolvedValueOnce({ items: rejected, nextCursor: null, labelProgress: [], providerRuns: running });
    mockApi.spies.review
      .mockRejectedValueOnce(new Error("select response lost"))
      .mockResolvedValueOnce({ items: [reviewState("candidate-3", "rejected")] });
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(mockApi.spies.review).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
  });

  it("首次对账失败后无后续操作也会定时重试并落地服务器真值", async () => {
    vi.useFakeTimers();
    const authoritative = baseCandidates.map((item) => item.id === "candidate-3"
      ? { ...item, reviewState: "rejected" as const, labelIds: [], primaryLabelId: null }
      : item);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockRejectedValueOnce(new Error("first reconciliation failed"))
      .mockResolvedValueOnce({ items: authoritative, nextCursor: null, labelProgress: [], providerRuns: [] });
    mockApi.spies.review.mockRejectedValueOnce(new Error("review outcome unknown"));
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("审核状态重新同步失败");
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected");
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(1199); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "rejected");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("卸载工作台会清理等待中的对账重试计时器", async () => {
    vi.useFakeTimers();
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    mockApi.spies.review.mockRejectedValueOnce(new Error("review outcome unknown"));
    const view = render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("路由从任务 A 切到 B 后忽略 A 的旧失败且不发起跨任务对账", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    const candidateA = candidate(31, { id: "candidate-a", jobId: "job-a", title: "A 的素材" });
    const candidateB = candidate(32, { id: "candidate-b", jobId: "job-b", title: "B 的素材" });
    const oldReview = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    let aLoads = 0;
    mockApi.reset({ details: [jobA, jobB], candidates: [] });
    mockApi.spies.listCandidates.mockImplementation((requestedJobId) => {
      if (requestedJobId === "job-b") return Promise.resolve({ items: [candidateB], nextCursor: null, labelProgress: [], providerRuns: [] });
      aLoads += 1;
      return Promise.resolve({ items: [candidateA], nextCursor: null, labelProgress: [], providerRuns: [] });
    });
    mockApi.spies.review.mockImplementationOnce(() => oldReview.promise);
    render(<RouteSwitchWorkbench />);
    await screen.findByText("A 的素材");

    fireEvent.click(screen.getByRole("button", { name: "选择A 的素材" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "切换到任务 B" }));
    expect(await screen.findByRole("main", { name: "任务 B工作台" })).toBeVisible();
    expect(await screen.findByText("B 的素材")).toBeVisible();

    await act(async () => { oldReview.reject(new Error("old job failed")); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(aLoads).toBe(1);
    expect(screen.getByRole("main", { name: "任务 B工作台" })).toBeVisible();
    expect(screen.getByText("B 的素材")).toBeVisible();
    expect(screen.queryByText("A 的素材")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("任务 A 已开始的延迟 reload 在切到 B 后不会写入 B 的候选或错误", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    const candidateA = candidate(41, { id: "candidate-a", jobId: "job-a", title: "A 的延迟素材" });
    const candidateB = candidate(42, { id: "candidate-b", jobId: "job-b", title: "B 的素材" });
    const delayedPage = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    mockApi.reset({ details: [jobA, jobB], candidates: [] });
    mockApi.spies.listCandidates.mockImplementation((requestedJobId, cursor) => {
      if (requestedJobId === "job-b") return Promise.resolve({ items: [candidateB], nextCursor: null, labelProgress: [], providerRuns: [] });
      if (cursor === undefined) return Promise.resolve({ items: [], nextCursor: 1, labelProgress: [], providerRuns: [] });
      return delayedPage.promise;
    });
    render(<RouteSwitchWorkbench />);
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledWith("job-a", 1));

    fireEvent.click(screen.getByRole("button", { name: "切换到任务 B" }));
    expect(await screen.findByText("B 的素材")).toBeVisible();
    await act(async () => {
      delayedPage.resolve({ items: [candidateA], nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });

    expect(screen.getByText("B 的素材")).toBeVisible();
    expect(screen.queryByText("A 的延迟素材")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("任务 A 的延迟批量完成不会清空任务 B 的新勾选", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    const candidateA = candidate(51, { id: "candidate-a", jobId: "job-a", title: "A 的素材" });
    const candidateB = candidate(52, { id: "candidate-b", jobId: "job-b", title: "B 的素材" });
    const oldBatch = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    mockApi.reset({ details: [jobA, jobB], candidates: [] });
    mockApi.spies.listCandidates.mockImplementation((requestedJobId) => Promise.resolve({
      items: requestedJobId === "job-a" ? [candidateA] : [candidateB], nextCursor: null, labelProgress: [], providerRuns: []
    }));
    mockApi.spies.review.mockImplementationOnce(() => oldBatch.promise);
    render(<RouteSwitchWorkbench />);
    await screen.findByText("A 的素材");

    fireEvent.click(screen.getByLabelText("勾选A 的素材"));
    fireEvent.click(screen.getByRole("button", { name: "批量选择" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "切换到任务 B" }));
    await screen.findByText("B 的素材");
    fireEvent.click(screen.getByLabelText("勾选B 的素材"));
    expect(screen.getByRole("button", { name: "批量选择" })).toBeVisible();

    await act(async () => {
      oldBatch.resolve({ items: [reviewState("candidate-a", "selected")] });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "批量选择" })).toBeVisible();
  });

  it("任务 A 的 Shift 锚点不会扩展任务 B 的首次 Shift 审核", async () => {
    const jobA = { ...job, id: "job-a", name: "任务 A" };
    const jobB = { ...job, id: "job-b", name: "任务 B" };
    const candidatesA = [1, 2, 3].map((index) => candidate(60 + index, { id: `candidate-a-${index}`, jobId: "job-a", title: `A-${index}` }));
    const candidatesB = [1, 2, 3].map((index) => candidate(70 + index, { id: `candidate-b-${index}`, jobId: "job-b", title: `B-${index}` }));
    mockApi.reset({ details: [jobA, jobB], candidates: [] });
    mockApi.spies.listCandidates.mockImplementation((requestedJobId) => Promise.resolve({
      items: requestedJobId === "job-a" ? candidatesA : candidatesB, nextCursor: null, labelProgress: [], providerRuns: []
    }));
    render(<RouteSwitchWorkbench />);
    await screen.findByText("A-3");

    fireEvent.click(screen.getByRole("button", { name: "拒绝A-3" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));
    mockApi.spies.review.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "切换到任务 B" }));
    await screen.findByText("B-1");
    fireEvent.click(screen.getByRole("button", { name: "拒绝B-1" }), { shiftKey: true });

    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-b", { candidateIds: ["candidate-b-1"], action: "reject" }));
  });

  it("Shift 锚点被筛选移出当前列表后只审核当前点击项", async () => {
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 4");

    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 3" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));
    mockApi.spies.review.mockClear();
    fireEvent.change(screen.getByLabelText("来源"), { target: { value: "brave" } });
    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 2" }), { shiftKey: true });

    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", { candidateIds: ["candidate-2"], action: "reject" }));
  });

  it("同一任务的新候选请求完成后忽略较旧请求的延迟失败", async () => {
    const staleReload = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: ProviderRunSummary[] }>();
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockImplementationOnce(() => staleReload.promise)
      .mockResolvedValueOnce({ items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: [] });
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3));
    await act(async () => { staleReload.reject(new Error("stale request failed")); await Promise.resolve(); });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("卸载后不再提交状态写入或发起失败对账", async () => {
    const pendingReview = deferred<{ items: ReturnType<typeof reviewState>[] }>();
    mockApi.spies.review.mockImplementationOnce(() => pendingReview.promise);
    const view = render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");
    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      pendingReview.reject(new Error("finished after unmount"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
  });

  it("范围和批量选择只提交已处理素材，但同一混合勾选仍可全部拒绝", async () => {
    const mixed = [...baseCandidates, candidate(9)];
    reset(mixed);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 9");

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    fireEvent.click(screen.getByRole("button", { name: "选择素材 9" }), { shiftKey: true });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", expect.objectContaining({
      action: "select", candidateIds: ["candidate-3", "candidate-4", "candidate-9"]
    })));

    fireEvent.click(screen.getByLabelText("全选当前素材"));
    fireEvent.click(screen.getByRole("button", { name: "批量选择" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", expect.objectContaining({
      action: "select", candidateIds: ["candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-9"]
    })));

    fireEvent.click(screen.getByLabelText("全选当前素材"));
    fireEvent.click(screen.getByRole("button", { name: "批量拒绝" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      action: "reject", candidateIds: mixed.filter((item) => item.discoveryLabelIds?.includes("label-a")).map((item) => item.id)
    }));
  });

  it("内容审核 Shift 范围选择分别保留各候选标签与主标签", async () => {
    const moderationJob = { ...job, taskType: "content_moderation" as const };
    const candidates = [
      candidate(3, { labelIds: ["label-b"], primaryLabelId: "label-b" }),
      candidate(4, { labelIds: ["label-c"], primaryLabelId: "label-c" })
    ];
    mockApi.reset({ details: [moderationJob], candidates });
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    fireEvent.click(screen.getByRole("button", { name: "选择素材 3" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "selected"));
    mockApi.spies.review.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "选择素材 4" }), { shiftKey: true });

    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(2));
    expect(mockApi.spies.review).toHaveBeenNthCalledWith(1, "job-workbench", {
      candidateIds: ["candidate-3"], action: "select", labelIds: ["label-a", "label-b"], primaryLabelId: "label-b"
    });
    expect(mockApi.spies.review).toHaveBeenNthCalledWith(2, "job-workbench", {
      candidateIds: ["candidate-4"], action: "select", labelIds: ["label-a", "label-c"], primaryLabelId: "label-c"
    });
  });

  it("内容审核批量选择不会把首个候选标签注入其它候选", async () => {
    const moderationJob = { ...job, taskType: "content_moderation" as const };
    const candidates = [
      candidate(3, { labelIds: ["label-b"], primaryLabelId: "label-b" }),
      candidate(4, { labelIds: ["label-c"], primaryLabelId: "label-c" })
    ];
    mockApi.reset({ details: [moderationJob], candidates });
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    fireEvent.click(screen.getByLabelText("勾选素材 3"));
    fireEvent.click(screen.getByLabelText("勾选素材 4"));
    fireEvent.click(screen.getByRole("button", { name: "批量选择" }));

    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledTimes(2));
    expect(mockApi.spies.review).toHaveBeenNthCalledWith(1, "job-workbench", {
      candidateIds: ["candidate-3"], action: "select", labelIds: ["label-a", "label-b"], primaryLabelId: "label-b"
    });
    expect(mockApi.spies.review).toHaveBeenNthCalledWith(2, "job-workbench", {
      candidateIds: ["candidate-4"], action: "select", labelIds: ["label-a", "label-c"], primaryLabelId: "label-c"
    });
  });

  it("勾选项没有可选择素材时显示真实通知且不提交审核", async () => {
    reset([candidate(6, { pipelineState: "invalid", assetId: null, pipelineError: "INVALID_IMAGE" })]);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材无效");

    fireEvent.click(screen.getByLabelText("全选当前素材"));
    fireEvent.click(screen.getByRole("button", { name: "批量选择" }));

    expect(screen.getByText("所勾选素材尚未完成本地处理，无法选择。")).toBeVisible();
    expect(mockApi.spies.review).not.toHaveBeenCalled();
  });

  it("分类任务只展示当前父路径的兄弟标签并保留安全来源参数", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    fireEvent.click(screen.getByRole("button", { name: "查看素材 1 详情" }));

    const move = screen.getByLabelText("移动到标签");
    expect(within(move).getByRole("option", { name: /耳机/ })).toBeInTheDocument();
    expect(within(move).queryByRole("option", { name: /冰箱/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开来源页面" })).toHaveAttribute("href", "https://shop.example/item-1?productId=1");
    fireEvent.keyDown(window, { key: "o" });
    expect(open).toHaveBeenCalledWith("https://shop.example/item-1?productId=1", "_blank", "noopener,noreferrer");
  });

  it("严格合规详情展示全部来源查询与许可证据，并可保存和清除权利依据", async () => {
    const strictJob = { ...job, exportMode: "strict_compliance" as const };
    const withProvenance = candidate(1, {
      rightsBasis: "unknown",
      rightsEvidence: null,
      provenance: [
        {
          hitId: "hit-openverse", queryRunId: "run-base", provider: "openverse", variantName: "base", query: "音箱 电商广告", page: 1,
          imageUrl: "https://cdn.example/a.jpg", landingPageUrl: "https://shop.example/a", title: "商品主图", creator: "品牌店",
          licenseName: "CC0", licenseUrl: "https://rights.example/cc0", sourceProvider: "Openverse", source: "Brand shop", rightsStatus: "cc0"
        },
        {
          hitId: "hit-brave", queryRunId: "run-style", provider: "brave", variantName: "style", query: "音箱 促销海报", page: 2,
          imageUrl: "https://cdn.example/b.jpg", landingPageUrl: "https://ads.example/b", title: "促销海报", creator: null,
          licenseName: "Licensed", licenseUrl: "https://rights.example/license/42", sourceProvider: "Brave Images", source: "Ads", rightsStatus: "provider_claimed"
        }
      ]
    });
    mockApi.reset({ details: [strictJob], candidates: [withProvenance] });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await user.click(await screen.findByRole("button", { name: "查看素材 1 详情" }));

    const drawer = screen.getByRole("complementary", { name: "素材溯源与信息" });
    expect(within(drawer).getByText("音箱 电商广告")).toBeVisible();
    expect(within(drawer).getByText("音箱 促销海报")).toBeVisible();
    expect(within(drawer).getByText("style · 第 2 页")).toBeVisible();
    expect(within(drawer).getByRole("link", { name: /Licensed/ })).toHaveAttribute("href", "https://rights.example/license/42");

    await user.selectOptions(within(drawer).getByLabelText("权利依据"), "licensed");
    await user.type(within(drawer).getByLabelText("权利证据 URL"), "https://rights.example/contracts/42");
    await user.click(within(drawer).getByRole("button", { name: "保存权利依据" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "licensed", rightsEvidence: "https://rights.example/contracts/42"
    }));

    await user.click(within(drawer).getByRole("button", { name: "清除权利依据" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "set_rights_evidence", rightsBasis: "unknown", rightsEvidence: null
    }));
  });

  it("零候选时仍展示每个失败平台的原因和可重试性", async () => {
    reset([], [
      { id: "run-retry", jobId: "job-workbench", labelId: "label-a", providerId: "brave", variantName: "base", query: "音箱 广告", status: "retryable", retryable: true, errorSummary: "提供方请求过于频繁，可稍后继续重试。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 30, hitCount: 0 },
      { id: "run-failed", jobId: "job-workbench", labelId: "label-a", providerId: "serpapi", variantName: "style", query: "音箱 促销", status: "failed", retryable: false, errorSummary: "提供方凭据无效或权限不足。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 20, hitCount: 0 }
    ]);
    render(<WorkbenchTestApp />);

    const status = await screen.findByRole("region", { name: "平台拉取状态" });
    expect(within(status).getByText("Brave")).toBeVisible();
    expect(within(status).getByText("SerpApi")).toBeVisible();
    expect(within(status).getByText("提供方请求过于频繁，可稍后继续重试。")).toBeVisible();
    expect(within(status).getByText("可重试")).toBeVisible();
    expect(within(status).getByText("需检查配置")).toBeVisible();
    expect(screen.getByText("当前筛选下没有素材")).toBeVisible();
  });

  it("失败状态使用服务端返回的新来源名称，而不是暴露内部 ID", async () => {
    const providers: ProviderStatus[] = [
      { id: "openverse", displayName: "Openverse", configured: false, enabled: true, rightsPolicy: "open", maxResults: 200, credentialVariables: [], credentialMode: "none", sourceCategory: "general", freeTier: "匿名公开 API", docsUrl: "https://docs.openverse.org/api/guides/", defaultSelected: true },
      { id: "dpla", displayName: "Digital Public Library of America", configured: false, enabled: false, rightsPolicy: "open", maxResults: 500, credentialVariables: ["DPLA_API_KEY"], credentialMode: "required", sourceCategory: "culture", freeTier: "免费申请 API Key", docsUrl: "https://pro.dp.la/developers/api-codex", defaultSelected: false }
    ];
    mockApi.reset({ details: [job], candidates: [candidate(21, { provider: "wikimedia", title: "Wikimedia 音箱", rightsStatus: "unknown" })], providers, providerRuns: [{
      id: "run-dpla", jobId: "job-workbench", labelId: "label-a", providerId: "dpla", variantName: "base",
      query: "音箱 广告", status: "failed", retryable: false, errorSummary: "未配置免费 Key。",
      createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 20, hitCount: 0
    }] });
    render(<WorkbenchTestApp />);

    expect(await screen.findByText("wikimedia · 授权未知")).toBeVisible();
    const status = screen.getByRole("region", { name: "平台拉取状态" });
    expect(within(status).getByText("Digital Public Library of America")).toBeVisible();
  });

  it("仅对含终止失败的来源显式重试，并同步阻止双击重复提交", async () => {
    const retry = deferred<{ status: "collecting" }>();
    reset([], [
      { id: "run-retryable", jobId: "job-workbench", labelId: "label-a", providerId: "brave", variantName: "base", query: "音箱 广告", status: "retryable", retryable: true, errorSummary: "请稍后继续。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 30, hitCount: 0 },
      { id: "run-terminal", jobId: "job-workbench", labelId: "label-a", providerId: "serpapi", variantName: "style", query: "音箱 促销", status: "failed", retryable: false, errorSummary: "请检查凭据。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 20, hitCount: 0 },
      { id: "run-mixed-retryable", jobId: "job-workbench", labelId: "label-a", providerId: "dataforseo", variantName: "base", query: "音箱 广告", status: "retryable", retryable: true, errorSummary: "请稍后继续。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 30, hitCount: 0 },
      { id: "run-mixed-terminal", jobId: "job-workbench", labelId: "label-a", providerId: "dataforseo", variantName: "style", query: "音箱 促销", status: "failed", retryable: false, errorSummary: "请检查凭据。", createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 20, hitCount: 0 }
    ]);
    mockApi.spies.startSearch.mockImplementation(() => retry.promise);
    render(<WorkbenchTestApp />);

    const status = await screen.findByRole("region", { name: "平台拉取状态" });
    const retryableOnly = within(status).getByText("Brave").closest("li")!;
    const terminal = within(status).getByText("SerpApi").closest("li")!;
    const mixed = within(status).getByText("DataForSEO").closest("li")!;
    expect(within(retryableOnly).queryByRole("button", { name: "重新尝试该来源" })).not.toBeInTheDocument();
    expect(within(mixed).getByRole("button", { name: "重新尝试该来源" })).toBeEnabled();

    const retryButton = within(terminal).getByRole("button", { name: "重新尝试该来源" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(mockApi.spies.startSearch).toHaveBeenCalledTimes(1);
    expect(mockApi.spies.startSearch).toHaveBeenCalledWith("job-workbench", {
      providerIds: ["serpapi"], retryFailedProviderIds: ["serpapi"]
    });
    expect(retryButton).toBeDisabled();
    await act(async () => { retry.resolve({ status: "collecting" }); await Promise.resolve(); });
  });

  it("对提供方可重试失败显示专用按钮，但本地可恢复中断仍交给普通继续搜索", async () => {
    const retry = deferred<{ status: "collecting" }>();
    reset([], [
      {
        id: "run-openverse-provider-retry", jobId: "job-workbench", labelId: "label-a", providerId: "openverse",
        variantName: "base", query: "speaker ecommerce advertisement", status: "retryable", retryable: true,
        requiresExplicitRetry: true, errorSummary: "提供方暂时不可用，可稍后继续重试。",
        createdAt: "now", startedAt: "now", completedAt: "later", durationMs: 30, hitCount: 0
      },
      {
        id: "run-brave-local-recovery", jobId: "job-workbench", labelId: "label-a", providerId: "brave",
        variantName: "base", query: "speaker advertisement", status: "retryable", retryable: true,
        requiresExplicitRetry: false, errorSummary: "搜索因本地服务重启而中断，可继续重试。",
        createdAt: "now", startedAt: "now", completedAt: null, durationMs: null, hitCount: 0
      }
    ] as ProviderRunSummary[]);
    mockApi.spies.startSearch
      .mockResolvedValueOnce({ status: "exhausted" })
      .mockImplementationOnce(() => retry.promise);
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const status = await screen.findByRole("region", { name: "平台拉取状态" });
    const openverse = within(status).getByText("Openverse").closest("li")!;
    const localRecovery = within(status).getByText("Brave").closest("li")!;
    const retryButton = within(openverse).getByRole("button", { name: "重新尝试该来源" });
    expect(retryButton).toBeEnabled();
    expect(within(localRecovery).queryByRole("button", { name: "重新尝试该来源" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续搜索" }));
    expect(mockApi.spies.startSearch).toHaveBeenNthCalledWith(1, "job-workbench", {
      providerIds: ["openverse"], retryFailedProviderIds: []
    });

    await user.click(retryButton);
    expect(mockApi.spies.startSearch).toHaveBeenNthCalledWith(2, "job-workbench", {
      providerIds: ["openverse"], retryFailedProviderIds: ["openverse"]
    });
    await act(async () => { retry.resolve({ status: "collecting" }); await Promise.resolve(); });
  });

  it("内容审核可增删跨分支多标签，移除主标签时自动选择集合内新主标签", async () => {
    const moderationJob = { ...job, taskType: "content_moderation" as const };
    mockApi.reset({ details: [moderationJob], candidates: [candidate(1, { reviewState: "selected", labelIds: ["label-a", "label-b"], primaryLabelId: "label-a" })] });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    await user.click(screen.getByRole("button", { name: "查看素材 1 详情" }));

    const group = screen.getByRole("group", { name: "内容审核标签" });
    expect(within(group).getByRole("checkbox", { name: /分配标签.*音箱/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /分配标签.*耳机/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /设为主标签.*音箱/ })).toBeChecked();

    await user.click(within(group).getByRole("checkbox", { name: /分配标签.*音箱/ }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["label-b"], primaryLabelId: "label-b"
    }));
    expect(within(group).getByRole("radio", { name: /设为主标签.*耳机/ })).toBeChecked();

    await user.click(within(group).getByRole("checkbox", { name: /分配标签.*冰箱/ }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["label-b", "label-c"], primaryLabelId: "label-b"
    }));
    await user.click(within(group).getByRole("radio", { name: /设为主标签.*冰箱/ }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenLastCalledWith("job-workbench", {
      candidateIds: ["candidate-1"], action: "set_labels", labelIds: ["label-b", "label-c"], primaryLabelId: "label-c"
    }));
  });

  it("内容审核隐藏时不向辅助技术暴露图片描述，显式揭示后卡片与详情恢复描述", async () => {
    const moderationJob = { ...job, taskType: "content_moderation" as const };
    mockApi.reset({ details: [moderationJob], candidates: [candidate(1), candidate(3)] });
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);

    const firstCard = await screen.findByTestId("candidate-candidate-1");
    const secondCard = screen.getByTestId("candidate-candidate-3");
    const first = firstCard.querySelector("img");
    const second = secondCard.querySelector("img");
    expect(first).toHaveAttribute("alt", "");
    expect(second).toHaveAttribute("alt", "");
    expect(first).toHaveClass("is-sensitive-hidden");
    expect(second).toHaveClass("is-sensitive-hidden");

    await user.click(screen.getByRole("button", { name: "查看素材 1 详情" }));
    const drawer = screen.getByRole("complementary", { name: "素材溯源与信息" });
    const drawerImage = drawer.querySelector("img");
    expect(drawerImage).toHaveAttribute("alt", "");

    await user.click(within(drawer).getByRole("button", { name: "显示敏感图片详情 素材 1" }));
    expect(first).not.toHaveClass("is-sensitive-hidden");
    expect(first).toHaveAttribute("alt", "候选素材 1");
    expect(drawerImage).toHaveAttribute("alt", "素材 1 本地缩略图");
    expect(second).toHaveAttribute("alt", "");
    expect(second).toHaveClass("is-sensitive-hidden");
    expect(screen.getByRole("button", { name: "显示敏感图片 素材 3" })).toBeVisible();
  });

  it("审核失败时回滚乐观状态并提供可访问错误通知", async () => {
    mockApi.spies.review.mockRejectedValueOnce(new Error("write failed"));
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 3");

    await user.click(screen.getByRole("button", { name: "选择素材 3" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("审核结果未保存");
    expect(screen.getByTestId("candidate-candidate-3")).toHaveAttribute("data-review-state", "unreviewed");
  });

  it("显示加载、无效与隔离占位并支持 S/R/J/K/Esc 快捷键", async () => {
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    expect(screen.getByRole("status", { name: "素材 5 正在处理" })).toBeVisible();
    expect(screen.getByText("素材无效")).toBeVisible();
    expect(screen.getByText("素材已隔离")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "查看素材 1 详情" }));
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", expect.objectContaining({ candidateIds: ["candidate-1"], action: "select" })));
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("complementary", { name: "素材溯源与信息" })).toHaveTextContent("素材 3");
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByRole("complementary", { name: "素材溯源与信息" })).toHaveTextContent("素材 1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "素材溯源与信息" })).not.toBeInTheDocument();
  });

  it("只在查询运行活跃时轮询候选，并能暂停当前任务", async () => {
    vi.useFakeTimers();
    reset(baseCandidates, [{ id: "run-1", jobId: "job-workbench", labelId: "label-a", providerId: "openverse", variantName: "base", query: "音箱 广告", status: "running", errorSummary: null, createdAt: "now", startedAt: "now", completedAt: null, durationMs: null, hitCount: 1 }]);
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates.mock.calls.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockApi.spies.pauseSearch).toHaveBeenCalledWith("job-workbench");
  });

  it("单次轮询失败后退避恢复，不并发重叠请求并在终态解锁", async () => {
    vi.useFakeTimers();
    const running: ProviderRunSummary[] = [{ id: "run-recover", jobId: "job-workbench", labelId: "label-a", providerId: "openverse", variantName: "base", query: "音箱 广告", status: "running", errorSummary: null, createdAt: "now", startedAt: "now", completedAt: null, durationMs: null, hitCount: 1 }];
    const initialPage = { items: baseCandidates, nextCursor: null, labelProgress: [], providerRuns: running };
    const recoveredPage = { items: [candidate(29)], nextCursor: null, labelProgress: [], providerRuns: [] };
    const recovery = deferred<typeof recoveredPage>();
    reset(baseCandidates, running);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce(initialPage)
      .mockRejectedValueOnce(new Error("temporary polling failure"))
      .mockImplementationOnce(() => recovery.promise);
    render(<WorkbenchTestApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("候选素材刷新失败");

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);

    await act(async () => { recovery.resolve(recoveredPage); await Promise.resolve(); });
    expect(screen.getByText("素材 29")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续搜索" })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3);
  });

  it("查询运行结束后仍轮询自动素材队列，直到所有候选处理完成", async () => {
    vi.useFakeTimers();
    const queued = [
      candidate(20, { pipelineState: "fetching", assetId: null, pipelineError: null }),
      candidate(21, { pipelineState: "discovered", assetId: null, pipelineError: null }),
      candidate(22, { pipelineState: "discovered", assetId: null, pipelineError: "CACHE_REBUILD_REQUIRED" }),
      candidate(23, { pipelineState: "discovered", assetId: null, pipelineError: "DOWNLOAD_INTERRUPTED" })
    ];
    const processed = queued.map((item) => ({
      ...item,
      pipelineState: "processed" as const,
      pipelineError: null,
      assetId: `asset-${item.id}`
    }));
    const page = (items: Candidate[]) => ({ items, nextCursor: null, labelProgress: [], providerRuns: [] });
    reset(queued);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce(page(queued))
      .mockResolvedValue(page(processed));
    render(<WorkbenchTestApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: "候选素材 20" })).toHaveAttribute("src", "/api/media/asset-candidate-20/thumbnail");

    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("已拒绝且尚未物化的候选不会触发后台轮询", async () => {
    vi.useFakeTimers();
    reset([candidate(30, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: null,
      reviewState: "rejected"
    })]);
    render(<WorkbenchTestApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "FORBIDDEN" as const },
    { code: "RATE_LIMITED" as const },
    { code: "NETWORK" as const },
    { code: "GENERIC" as const },
    { code: null },
    { code: "__proto__" as unknown as Candidate["pipelineFailureCode"] }
  ])("可人工重试的下载失败（$code）不会进入审核列表或候选计数", async ({ code }) => {
    vi.useFakeTimers();
    reset([candidate(24, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: code
    })]);
    render(<WorkbenchTestApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("candidate-candidate-24")).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "分类队列" })).getByRole("button", { name: /音箱/ })).toHaveTextContent("0 已选 · 0 候选");
    expect(screen.getByRole("button", { name: "继续搜索" })).toBeEnabled();
  });

  it("全选和批量拒绝不会包含隐藏的下载受限候选", async () => {
    reset([candidate(1), candidate(26, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: "NETWORK"
    })]);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");

    expect(screen.queryByTestId("candidate-candidate-26")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("全选当前素材"));
    fireEvent.click(screen.getByRole("button", { name: "批量拒绝" }));

    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", {
      action: "reject", candidateIds: ["candidate-1"]
    }));
  });

  it("已勾选素材转为下载受限后不再显示批量审核入口", async () => {
    vi.useFakeTimers();
    const fetching = candidate(28, { pipelineState: "fetching", assetId: null });
    const limited = candidate(28, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: "NETWORK"
    });
    const recovered = candidate(28, {
      pipelineState: "processed",
      assetId: "asset-28-recovered",
      pipelineError: null,
      pipelineFailureCode: null
    });
    reset([fetching]);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: [fetching], nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockResolvedValueOnce({ items: [limited], nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockResolvedValueOnce({ items: [recovered], nextCursor: null, labelProgress: [], providerRuns: [] });
    render(<WorkbenchTestApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByLabelText("勾选素材 28"));
    fireEvent.click(screen.getByRole("button", { name: "查看素材 28 详情" }));
    expect(screen.getByRole("button", { name: "批量拒绝" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "素材溯源与信息" })).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });

    expect(screen.queryByTestId("candidate-candidate-28")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量选择" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量拒绝" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "素材溯源与信息" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续搜索" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByRole("img", { name: "候选素材 28" })).toHaveAttribute("src", "/api/media/asset-28-recovered/thumbnail");
    expect(screen.getByLabelText("勾选素材 28")).not.toBeChecked();
    expect(screen.queryByRole("complementary", { name: "素材溯源与信息" })).not.toBeInTheDocument();
  });

  it("人工审核与下载失败并发时仍从审核列表隐藏受限素材", async () => {
    vi.useFakeTimers();
    const fetching = candidate(31, { pipelineState: "fetching", assetId: null });
    const limited = candidate(31, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: "NETWORK",
      reviewState: "rejected"
    });
    const downloadPoll = deferred<{ items: Candidate[]; nextCursor: null; labelProgress: never[]; providerRuns: never[] }>();
    reset([fetching]);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: [fetching], nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockImplementationOnce(() => downloadPoll.promise);
    render(<WorkbenchTestApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "拒绝素材 31" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", {
      action: "reject", candidateIds: ["candidate-31"]
    });
    expect(screen.getByTestId("candidate-candidate-31")).toHaveAttribute("data-review-state", "rejected");

    await act(async () => {
      downloadPoll.resolve({ items: [limited], nextCursor: null, labelProgress: [], providerRuns: [] });
      await Promise.resolve();
    });

    expect(screen.queryByTestId("candidate-candidate-31")).not.toBeInTheDocument();
  });

  it("下载受限候选在继续搜索下载成功后重新进入审核列表", async () => {
    const limited = candidate(27, {
      pipelineState: "discovered",
      assetId: null,
      pipelineError: "RETRYABLE_DOWNLOAD",
      pipelineFailureCode: "RATE_LIMITED"
    });
    const recovered = candidate(27, {
      pipelineState: "processed",
      assetId: "asset-27-recovered",
      pipelineError: null,
      pipelineFailureCode: null
    });
    reset([limited]);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce({ items: [limited], nextCursor: null, labelProgress: [], providerRuns: [] })
      .mockResolvedValueOnce({ items: [recovered], nextCursor: null, labelProgress: [], providerRuns: [] });
    render(<WorkbenchTestApp />);

    await screen.findByRole("main", { name: "音箱广告采集工作台" });
    expect(screen.queryByTestId("candidate-candidate-27")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续搜索" }));

    expect(await screen.findByRole("img", { name: "候选素材 27" })).toHaveAttribute("src", "/api/media/asset-27-recovered/thumbnail");
    expect(within(screen.getByRole("navigation", { name: "分类队列" })).getByRole("button", { name: /音箱/ })).toHaveTextContent("0 已选 · 1 候选");
    expect(screen.queryByText("本轮未新增素材；已选来源或查询可能已耗尽，请增加来源或调整条件。")).not.toBeInTheDocument();
  });

  it("本地缩略图加载失败时显示可见回退并保留审核操作", async () => {
    const user = userEvent.setup();
    reset([candidate(25)]);
    render(<WorkbenchTestApp />);

    const card = await screen.findByTestId("candidate-candidate-25");
    const image = within(card).getByRole("img", { name: "候选素材 25" });
    fireEvent.error(image);

    expect(within(card).queryByRole("img", { name: "候选素材 25" })).not.toBeInTheDocument();
    expect(within(card).getByText("本地缩略图不可用")).toBeVisible();
    expect(within(card).getByText("请刷新任务或继续搜索重新生成")).toBeVisible();
    expect(within(card).getByRole("button", { name: "选择素材 25" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "拒绝素材 25" })).toBeEnabled();

    await user.click(within(card).getByRole("button", { name: "拒绝素材 25" }));
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", expect.objectContaining({ candidateIds: ["candidate-25"], action: "reject" })));
  });

  it("同一 assetId 的普通刷新保留缩略图占位，assetId 更新后重新显示图片", async () => {
    const initial = candidate(25);
    const rebuilt = candidate(25, { assetId: "asset-25-rebuilt" });
    const page = (items: Candidate[]) => ({ items, nextCursor: null, labelProgress: [], providerRuns: [] });
    reset([initial]);
    mockApi.spies.listCandidates
      .mockResolvedValueOnce(page([initial]))
      .mockResolvedValueOnce(page([{ ...initial }]))
      .mockResolvedValueOnce(page([rebuilt]));
    render(<WorkbenchTestApp />);

    const card = await screen.findByTestId("candidate-candidate-25");
    fireEvent.error(within(card).getByRole("img", { name: "候选素材 25" }));
    expect(within(card).getByText("本地缩略图不可用")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(2));
    expect(within(card).queryByRole("img", { name: "候选素材 25" })).not.toBeInTheDocument();
    expect(within(card).getByText("本地缩略图不可用")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mockApi.spies.listCandidates).toHaveBeenCalledTimes(3));
    expect(within(card).getByRole("img", { name: "候选素材 25" })).toHaveAttribute("src", "/api/media/asset-25-rebuilt/thumbnail");
    expect(within(card).queryByText("本地缩略图不可用")).not.toBeInTheDocument();
  });

  it("提供可访问的窄屏分类侧滑层开关", async () => {
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");

    const open = screen.getByRole("button", { name: "打开分类队列" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "关闭分类队列" })).not.toBeInTheDocument();
    open.focus();
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const close = screen.getByRole("button", { name: "关闭分类队列" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "分类队列" }), { key: "Tab", shiftKey: true });
    expect(screen.getAllByRole("button", { name: /家电 \/ 厨房电器 \/ 冰箱/ }).at(-1)).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "分类队列" }), { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "分类队列" }), { key: "Escape" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "关闭分类队列" })).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("分类侧滑层支持点击遮罩关闭并恢复触发焦点", async () => {
    const user = userEvent.setup();
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    const open = screen.getByRole("button", { name: "打开分类队列" });
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "关闭分类队列遮罩" }));
    expect(screen.queryByRole("dialog", { name: "分类队列" })).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("窄屏分类层打开时切换到桌面断点会关闭弹层、移除焦点陷阱并恢复快捷键", async () => {
    const desktop = controllableDesktopQuery(false);
    vi.stubGlobal("matchMedia", desktop.matchMedia);
    const view = render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    const open = screen.getByRole("button", { name: "打开分类队列" });
    open.focus();
    fireEvent.click(open);
    expect(screen.getByRole("dialog", { name: "分类队列" })).toBeVisible();
    fireEvent.keyDown(window, { key: "s" });
    expect(mockApi.spies.review).not.toHaveBeenCalled();

    act(() => { desktop.change(true); });

    expect(screen.queryByRole("dialog", { name: "分类队列" })).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(mockApi.spies.review).toHaveBeenCalledWith("job-workbench", expect.objectContaining({ candidateIds: ["candidate-1"], action: "select" })));

    view.unmount();
    expect(desktop.mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("导出对话框打开时暂停工作台快捷键与来源打开", async () => {
    const openSource = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<WorkbenchTestApp />);
    await screen.findByText("素材 1");
    fireEvent.click(screen.getByRole("button", { name: "查看素材 1 详情" }));
    fireEvent.click(screen.getByRole("button", { name: "导出数据集" }));
    const dialog = await screen.findByRole("dialog", { name: "导出数据集" });

    for (const key of ["s", "r", "j", "k", "o"]) fireEvent.keyDown(dialog, { key });

    expect(mockApi.spies.review).not.toHaveBeenCalled();
    expect(openSource).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "素材溯源与信息" })).toHaveTextContent("素材 1");
  });
});
