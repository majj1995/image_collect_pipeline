// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLocalSettings, type LocalSettings, type ProviderStatus } from "../../src/shared/contracts.js";
import { TestApp, mockApi } from "../helpers/client.js";

const providers: ProviderStatus[] = [
  { id: "openverse", displayName: "Openverse", configured: false, enabled: true, rightsPolicy: "open", maxResults: 200, credentialVariables: [], credentialMode: "none", sourceCategory: "general", freeTier: "匿名公开 API", docsUrl: "https://docs.openverse.org/api/guides/", defaultSelected: true },
  { id: "smithsonian", displayName: "Smithsonian Open Access", configured: false, enabled: true, rightsPolicy: "open", maxResults: 100, credentialVariables: ["SMITHSONIAN_API_KEY"], credentialMode: "optional", sourceCategory: "culture", freeTier: "DEMO_KEY 每 IP 30 次/小时、50 次/天", docsUrl: "https://edan.si.edu/openaccess/apidocs/", defaultSelected: false },
  { id: "pexels", displayName: "Pexels", configured: false, enabled: false, rightsPolicy: "discovery_only", maxResults: 80, credentialVariables: ["PEXELS_API_KEY"], credentialMode: "required", sourceCategory: "general", freeTier: "免费开发者 API Key", docsUrl: "https://www.pexels.com/api/documentation/", defaultSelected: false },
  { id: "tiktok_ads", displayName: "TikTok Commercial Content", configured: false, enabled: false, rightsPolicy: "discovery_only", maxResults: 10, credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], credentialMode: "approval", sourceCategory: "ad_library", freeTier: "免费申请审批", docsUrl: "https://developers.tiktok.com/products/commercial-content-api", defaultSelected: false },
  { id: "brave", displayName: "Brave Images（旧数据兼容）", configured: true, enabled: true, rightsPolicy: "contractual", maxResults: 100, credentialVariables: ["BRAVE_SEARCH_API_KEY"], credentialMode: "required", sourceCategory: "general", freeTier: "旧数据兼容来源", docsUrl: "https://api-dashboard.search.brave.com/app/documentation", defaultSelected: false }
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("本地设置页", () => {
  afterEach(cleanup);
  beforeEach(() => mockApi.reset({ providers, settings: structuredClone(defaultLocalSettings) }));

  it("展示免费渠道的访问门槛、来源类别、额度说明和官方入口，但不提供密钥输入或值", async () => {
    render(<TestApp initialEntries={["/settings"]} />);

    expect(await screen.findByRole("heading", { name: "本地设置" })).toBeVisible();
    const table = screen.getByRole("table", { name: "图片搜索提供方" });
    for (const provider of providers) expect(within(table).getByText(provider.displayName)).toBeVisible();
    expect(within(table).getByText("Openverse").closest("tr")).toHaveTextContent("匿名可用");
    expect(within(table).getByText("Openverse").closest("tr")).toHaveTextContent("无需变量");
    expect(within(table).getByText("Openverse").closest("tr")).toHaveTextContent("免 Key");
    expect(within(table).getByText("Smithsonian Open Access").closest("tr")).toHaveTextContent("免 Key（可选免费 Key）");
    expect(within(table).getByText("Pexels").closest("tr")).toHaveTextContent("免费 Key / 账号");
    expect(within(table).getByText("TikTok Commercial Content").closest("tr")).toHaveTextContent("免费申请 / 审批");
    expect(within(table).getByText("TikTok Commercial Content").closest("tr")).toHaveTextContent("广告资料库");
    expect(within(table).getByText("PEXELS_API_KEY")).toBeVisible();
    expect(within(table).getByRole("link", { name: "查看 Pexels 官方说明" })).toHaveAttribute("href", "https://www.pexels.com/api/documentation/");
    expect(screen.queryByLabelText(/API Key|密钥|密码/u)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "声明 Brave Images（旧数据兼容） 已取得合同存储与训练权利" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /声明 Openverse/u })).not.toBeInTheDocument();
  });

  it("通过严格完整对象保存地区、安全搜索和收紧后的缓存阈值", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/settings"]} />);
    await screen.findByRole("heading", { name: "本地设置" });

    await user.clear(screen.getByLabelText("默认语言地区"));
    await user.type(screen.getByLabelText("默认语言地区"), "en-GB");
    await user.clear(screen.getByLabelText("默认国家"));
    await user.type(screen.getByLabelText("默认国家"), "GB");
    await user.click(screen.getByLabelText("默认启用安全搜索"));
    await user.clear(screen.getByLabelText("下载超时（毫秒）"));
    await user.type(screen.getByLabelText("下载超时（毫秒）"), "15000");
    await user.click(screen.getByRole("button", { name: "保存本地设置" }));

    await waitFor(() => expect(mockApi.spies.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      defaultLocale: "en-GB",
      defaultCountry: "GB",
      safeSearch: false,
      cache: expect.objectContaining({ downloadTimeoutMs: 15_000 })
    })));
    expect(await screen.findByRole("status", { name: "设置保存状态" })).toHaveTextContent("设置已保存");
  });

  it("合同声明先乐观更新，保存失败时回滚并给出可访问错误", async () => {
    const pending = deferred<LocalSettings>();
    mockApi.reset({
      providers,
      settings: structuredClone(defaultLocalSettings),
      api: { updateSettings: vi.fn(() => pending.promise) }
    });
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/settings"]} />);
    const declaration = await screen.findByRole("checkbox", { name: "声明 Brave Images（旧数据兼容） 已取得合同存储与训练权利" });

    await user.click(declaration);
    expect(declaration).toBeChecked();
    pending.reject(new Error("write failed"));

    await waitFor(() => expect(declaration).not.toBeChecked());
    expect(screen.getByRole("alert")).toHaveTextContent("声明保存失败，已恢复上次设置");
  });
});
