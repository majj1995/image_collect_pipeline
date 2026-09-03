// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestApp, mockApi } from "../helpers/client.js";

describe("新建采集任务", () => {
  afterEach(cleanup);

  beforeEach(() => mockApi.reset({ jobs: [] }));

  it("展示所有继承默认值，并在提交前逐行报告标签路径错误", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    expect(screen.getByRole("dialog", { name: "新建采集任务" })).toBeVisible();
    expect(screen.getByLabelText("中文素材风格")).toHaveValue("");
    expect(screen.getByLabelText("英文素材风格")).toHaveValue("");
    expect(screen.getByLabelText("目标素材数")).toHaveValue(30);
    expect(screen.getByLabelText("候选素材数")).toHaveValue(100);
    expect(screen.getByText("主查询词逐行对应标签路径；每行可用逗号填写同义词。")).toBeVisible();

    await user.type(screen.getByLabelText("任务名称"), "错误示例");
    await user.type(
      screen.getByLabelText("标签路径"),
      "电商快销>>音箱{enter}电商快销>3C及电器>音箱{enter}电商快销/3C及电器/音箱"
    );
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(screen.getByText("第 1 行：标签层级不能为空")).toBeVisible();
    expect(screen.getByText("第 3 行：与第 2 行标签路径重复")).toBeVisible();
    expect(mockApi.spies.createJob).not.toHaveBeenCalled();
  });

  it("creates a job from a pasted taxonomy path", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    await user.type(screen.getByLabelText("任务名称"), "音箱广告素材");
    await user.type(screen.getByLabelText("标签路径"), "电商快销>3C及电器>影音电器>音箱");
    await user.type(screen.getByLabelText("中文主查询词"), "音箱");
    await user.type(screen.getByLabelText("英文主查询词"), "speaker");
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(await screen.findByText("音箱广告素材")).toBeVisible();
    expect(screen.getByText("电商快销 / 3C及电器 / 影音电器 / 音箱")).toBeVisible();
    expect(mockApi.spies.createJob).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "advertiser_product_taxonomy",
      exportMode: "internal_research",
      styles: [],
      targetCount: 30,
      candidateCount: 100,
      labelPaths: ["电商快销>3C及电器>影音电器>音箱"]
    }));
  });

  it("为每条标签提交中英文查询配置及各自的检索限制", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "双语音箱广告素材" } });
    fireEvent.change(screen.getByLabelText("标签路径"), { target: { value: "电商快销>3C及电器>影音电器>音箱\n电商快销>3C及电器>影音电器>家庭影院" } });
    fireEvent.change(screen.getByLabelText("中文主查询词"), { target: { value: "音箱,蓝牙音箱\n家庭影院,影院音响" } });
    fireEvent.change(screen.getByLabelText("英文主查询词"), { target: { value: "speaker,bluetooth speaker\nhome theater,theater sound system" } });
    fireEvent.change(screen.getByLabelText("中文素材风格"), { target: { value: "电商广告,商品展示" } });
    fireEvent.change(screen.getByLabelText("英文素材风格"), { target: { value: "ecommerce advertisement,product showcase" } });
    fireEvent.change(screen.getByLabelText("中文必须包含词"), { target: { value: "促销,新品" } });
    fireEvent.change(screen.getByLabelText("英文必须包含词"), { target: { value: "promotion,new arrival" } });
    fireEvent.change(screen.getByLabelText("中文排除词"), { target: { value: "实拍,评测" } });
    fireEvent.change(screen.getByLabelText("英文排除词"), { target: { value: "real photo,review" } });
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(mockApi.spies.createJob).toHaveBeenCalledTimes(1);
    expect(mockApi.spies.createJob.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      labelSearchProfiles: [
        {
          labelPath: "电商快销>3C及电器>影音电器>音箱",
          zh: {
            terms: ["音箱", "蓝牙音箱"],
            styles: ["电商广告", "商品展示"],
            requiredTerms: ["促销", "新品"],
            excludedTerms: ["实拍", "评测"]
          },
          en: {
            terms: ["speaker", "bluetooth speaker"],
            styles: ["ecommerce advertisement", "product showcase"],
            requiredTerms: ["promotion", "new arrival"],
            excludedTerms: ["real photo", "review"]
          }
        },
        {
          labelPath: "电商快销>3C及电器>影音电器>家庭影院",
          zh: {
            terms: ["家庭影院", "影院音响"],
            styles: ["电商广告", "商品展示"],
            requiredTerms: ["促销", "新品"],
            excludedTerms: ["实拍", "评测"]
          },
          en: {
            terms: ["home theater", "theater sound system"],
            styles: ["ecommerce advertisement", "product showcase"],
            requiredTerms: ["promotion", "new arrival"],
            excludedTerms: ["real photo", "review"]
          }
        }
      ]
    }));
  });

  it("中英文主查询词缺行或数量与标签不一致时显示中文错误并阻止提交", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    await user.type(screen.getByLabelText("任务名称"), "双语查询错误示例");
    await user.type(screen.getByLabelText("标签路径"), "电商快销>3C及电器>音箱{enter}电商快销>3C及电器>家庭影院");
    const chineseTerms = screen.getByLabelText("中文主查询词");
    const englishTerms = screen.getByLabelText("英文主查询词");
    await user.type(chineseTerms, "音箱{enter}");
    await user.type(englishTerms, "speaker");
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(screen.getByRole("alert", { name: "请修正以下问题" })).toHaveTextContent("中文主查询词第 2 行不能为空");
    expect(screen.getByRole("alert", { name: "请修正以下问题" })).toHaveTextContent("英文主查询词行数必须与标签路径数量一致");
    expect(chineseTerms).toHaveAttribute("aria-invalid", "true");
    expect(chineseTerms).toHaveAttribute("aria-describedby");
    expect(chineseTerms).toHaveAccessibleDescription("中文主查询词第 2 行不能为空");
    expect(englishTerms).toHaveAttribute("aria-invalid", "true");
    expect(englishTerms).toHaveAttribute("aria-describedby");
    expect(englishTerms).toHaveAccessibleDescription("英文主查询词行数必须与标签路径数量一致");
    expect(chineseTerms).toHaveFocus();
    expect(mockApi.spies.createJob).not.toHaveBeenCalled();
  });

  it("候选素材数小于目标素材数时显示中文错误并阻止提交", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    await user.type(screen.getByLabelText("任务名称"), "数量错误示例");
    await user.type(screen.getByLabelText("标签路径"), "电商快销>3C及电器>音箱");
    await user.clear(screen.getByLabelText("候选素材数"));
    await user.type(screen.getByLabelText("候选素材数"), "20");
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(screen.getByRole("alert", { name: "请修正以下问题" })).toHaveTextContent("候选素材数不能小于目标素材数");
    expect(mockApi.spies.createJob).not.toHaveBeenCalled();
  });

  it("仅为内容审核提交显式勾选的风险类别", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    expect(screen.queryByRole("group", { name: "允许检索的风险类别" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "内容审核" }));
    expect(screen.getByRole("group", { name: "允许检索的风险类别" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "成人内容" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "血腥暴力" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "自伤" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "成人内容" }));
    await user.click(screen.getByRole("checkbox", { name: "自伤" }));
    await user.type(screen.getByLabelText("任务名称"), "风险审核素材");
    await user.type(screen.getByLabelText("标签路径"), "内容安全>风险审核");
    await user.type(screen.getByLabelText("中文主查询词"), "风险内容");
    await user.type(screen.getByLabelText("英文主查询词"), "risky content");
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    expect(mockApi.spies.createJob).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "content_moderation",
      allowedRiskCategories: ["adult_content", "self_harm"]
    }));
  });

  it("切回广告品类时清空风险类别且不携带到提交参数", async () => {
    const user = userEvent.setup();
    render(<TestApp initialEntries={["/"]} />);

    await user.click(await screen.findByRole("button", { name: "新建采集任务" }));
    await user.click(screen.getByRole("radio", { name: "内容审核" }));
    await user.click(screen.getByRole("checkbox", { name: "血腥暴力" }));
    await user.click(screen.getByRole("radio", { name: "广告品类标注" }));
    expect(screen.queryByRole("group", { name: "允许检索的风险类别" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("任务名称"), "品类素材");
    await user.type(screen.getByLabelText("标签路径"), "电商快销>影音电器>音箱");
    await user.type(screen.getByLabelText("中文主查询词"), "音箱");
    await user.type(screen.getByLabelText("英文主查询词"), "speaker");
    await user.click(screen.getByRole("button", { name: "创建并进入工作台" }));

    const submitted = mockApi.spies.createJob.mock.calls[0]?.[0];
    expect(submitted).toEqual(expect.objectContaining({ taskType: "advertiser_product_taxonomy" }));
    expect(submitted).not.toHaveProperty("allowedRiskCategories");
  });
});
