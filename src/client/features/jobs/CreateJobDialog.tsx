import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useNavigate } from "react-router-dom";
import {
  searchPlatformIds,
  searchPlatformLabels,
  type CreateJobInput,
  type ExportMode,
  type ModerationRiskCategory,
  type SearchPlatform,
  type TaskType
} from "../../../shared/contracts.js";
import { ApiError, useApi } from "../../api.js";

interface TaxonomyIssue {
  line: number;
  message: string;
}

interface TaxonomyAnalysis {
  labelPaths: string[];
  issues: TaxonomyIssue[];
}

function analyzeTaxonomy(value: string): TaxonomyAnalysis {
  const lines = value.split(/\r?\n/u);
  const issues: TaxonomyIssue[] = [];
  const labelPaths: string[] = [];
  const firstLineByPath = new Map<string, number>();

  lines.forEach((source, index) => {
    const line = index + 1;
    const trimmed = source.trim();
    if (!trimmed) return;
    const parts = trimmed.normalize("NFKC").split(/\s*(?:>|\/|\t)\s*/u).map((part) => part.trim());
    if (parts.some((part) => part.length === 0)) {
      issues.push({ line, message: "标签层级不能为空" });
      return;
    }
    const key = parts.join("\u001f");
    const firstLine = firstLineByPath.get(key);
    if (firstLine !== undefined) {
      issues.push({ line, message: `与第 ${firstLine} 行标签路径重复` });
      return;
    }
    firstLineByPath.set(key, line);
    labelPaths.push(trimmed);
  });

  if (labelPaths.length === 0 && issues.length === 0) issues.push({ line: 1, message: "请至少输入一条标签路径" });
  return { labelPaths, issues };
}

function parseTerms(value: string): string[] {
  return value
    .split(/[\n,，]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface QueryRowsAnalysis {
  rows: string[][];
  issues: string[];
}

function analyzeQueryRows(value: string, expectedRows: number, fieldName: string): QueryRowsAnalysis {
  const lines = value.split(/\r?\n/u);
  while (lines.length > expectedRows && lines.at(-1)?.trim() === "") lines.pop();
  const rows = lines.map((line) => line.split(/[,，]+/u).map((term) => term.trim()).filter(Boolean));
  const issues: string[] = [];
  if (rows.length !== expectedRows) {
    issues.push(`${fieldName}行数必须与标签路径数量一致`);
  } else {
    rows.forEach((terms, index) => {
      if (terms.length === 0) issues.push(`${fieldName}第 ${index + 1} 行不能为空`);
    });
  }
  return { rows, issues };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
  )].filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export function CreateJobDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const zhQueryTermsRef = useRef<HTMLTextAreaElement>(null);
  const enQueryTermsRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("advertiser_product_taxonomy");
  const [exportMode, setExportMode] = useState<ExportMode>("internal_research");
  const [searchPlatforms, setSearchPlatforms] = useState<SearchPlatform[]>([...searchPlatformIds]);
  const [allowedRiskCategories, setAllowedRiskCategories] = useState<ModerationRiskCategory[]>([]);
  const [taxonomyText, setTaxonomyText] = useState("");
  const [zhQueryTermsText, setZhQueryTermsText] = useState("");
  const [enQueryTermsText, setEnQueryTermsText] = useState("");
  const [zhStylesText, setZhStylesText] = useState("");
  const [enStylesText, setEnStylesText] = useState("");
  const [zhRequiredText, setZhRequiredText] = useState("");
  const [enRequiredText, setEnRequiredText] = useState("");
  const [zhExcludedText, setZhExcludedText] = useState("");
  const [enExcludedText, setEnExcludedText] = useState("");
  const [targetCount, setTargetCount] = useState(30);
  const [candidateCount, setCandidateCount] = useState(100);
  const [taxonomyTouched, setTaxonomyTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const taxonomy = useMemo(() => analyzeTaxonomy(taxonomyText), [taxonomyText]);
  const zhQueryRows = useMemo(
    () => analyzeQueryRows(zhQueryTermsText, taxonomy.labelPaths.length, "中文主查询词"),
    [taxonomy.labelPaths.length, zhQueryTermsText]
  );
  const enQueryRows = useMemo(
    () => analyzeQueryRows(enQueryTermsText, taxonomy.labelPaths.length, "英文主查询词"),
    [enQueryTermsText, taxonomy.labelPaths.length]
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const nameError = attempted && !name.trim() ? "请输入任务名称" : null;
  const countsOutOfRange = (
    !Number.isInteger(targetCount) || targetCount < 1 || targetCount > 1000 ||
    !Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 1000
  );
  const candidateBelowTarget = candidateCount < targetCount;
  const countsInvalid = countsOutOfRange || candidateBelowTarget;
  const countError = !attempted
    ? null
    : countsOutOfRange
      ? "素材数量需为 1–1000 的整数"
      : candidateBelowTarget
        ? "候选素材数不能小于目标素材数"
        : null;
  const visibleTaxonomyIssues = taxonomyTouched || attempted ? taxonomy.issues : [];
  const visibleQueryIssues = attempted ? [...zhQueryRows.issues, ...enQueryRows.issues] : [];
  const zhQueryError = attempted ? zhQueryRows.issues.join("；") || null : null;
  const enQueryError = attempted ? enQueryRows.issues.join("；") || null : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    setTaxonomyTouched(true);
    setSubmitError(null);
    const invalid = (
      !name.trim() || taxonomy.issues.length > 0 || taxonomy.labelPaths.length === 0 || countsInvalid ||
      zhQueryRows.issues.length > 0 || enQueryRows.issues.length > 0
    );
    if (invalid) {
      if (!name.trim()) nameRef.current?.focus();
      else if (zhQueryRows.issues.length > 0) zhQueryTermsRef.current?.focus();
      else if (enQueryRows.issues.length > 0) enQueryTermsRef.current?.focus();
      return;
    }

    const zhStyles = parseTerms(zhStylesText);
    const enStyles = parseTerms(enStylesText);
    const zhRequiredTerms = parseTerms(zhRequiredText);
    const enRequiredTerms = parseTerms(enRequiredText);
    const zhExcludedTerms = parseTerms(zhExcludedText);
    const enExcludedTerms = parseTerms(enExcludedText);

    const input: CreateJobInput = {
      name: name.trim(),
      taskType,
      exportMode,
      searchPlatforms,
      labelPaths: taxonomy.labelPaths,
      labelSearchProfiles: taxonomy.labelPaths.map((labelPath, index) => ({
        labelPath,
        zh: {
          terms: zhQueryRows.rows[index]!, styles: zhStyles,
          requiredTerms: zhRequiredTerms, excludedTerms: zhExcludedTerms
        },
        en: {
          terms: enQueryRows.rows[index]!, styles: enStyles,
          requiredTerms: enRequiredTerms, excludedTerms: enExcludedTerms
        }
      })),
      aliases: [],
      styles: zhStyles,
      requiredTerms: zhRequiredTerms,
      excludedTerms: zhExcludedTerms,
      targetCount,
      candidateCount,
      ...(taskType === "content_moderation" && allowedRiskCategories.length > 0 ? { allowedRiskCategories } : {})
    };
    setSubmitting(true);
    try {
      const job = await api.createJob(input);
      navigate(`/jobs/${job.id}`);
    } catch (reason) {
      setSubmitError(reason instanceof ApiError ? reason.message : "创建任务失败，请重试。");
      setSubmitting(false);
    }
  };

  const keepOverlayKeyboardNeutral = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={keepOverlayKeyboardNeutral}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-job-title"
        aria-describedby="create-job-description"
      >
        <div className="dialog__header">
          <div>
            <h2 id="create-job-title">新建采集任务</h2>
            <p id="create-job-description">粘贴一个或多个标签路径，快速建立素材采集队列。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭新建采集任务" onClick={onClose}>
            <X aria-hidden="true" size={18} strokeWidth={1.8} />
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          <div className="dialog__body">
            {(nameError || countError || visibleTaxonomyIssues.length > 0 || visibleQueryIssues.length > 0 || submitError) ? (
              <div className="form-summary" role="alert" aria-label="请修正以下问题">
                <strong>请修正以下问题</strong>
                <ul>
                  {nameError ? <li>{nameError}</li> : null}
                  {visibleTaxonomyIssues.map((issue) => <li key={`${issue.line}-${issue.message}`}>第 {issue.line} 行：{issue.message}</li>)}
                  {visibleQueryIssues.map((issue) => <li key={issue}>{issue}</li>)}
                  {countError ? <li>{countError}</li> : null}
                  {submitError ? <li>{submitError}</li> : null}
                </ul>
              </div>
            ) : null}

            <section className="form-section" aria-labelledby="basic-section-title">
              <div className="form-section__heading">
                <span className="form-section__index" aria-hidden="true">01</span>
                <div><h3 id="basic-section-title">任务定义</h3><p>先确定后训练场景和导出约束。</p></div>
              </div>
              <div className="form-grid form-grid--single">
                <label className="field" htmlFor="job-name">
                  <span>任务名称</span>
                  <input
                    ref={nameRef}
                    id="job-name"
                    aria-label="任务名称"
                    value={name}
                    maxLength={120}
                    aria-invalid={Boolean(nameError)}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="例如：音箱广告素材"
                  />
                  <small>用于在本机区分采集批次。</small>
                </label>
              </div>
              <div className="form-grid">
                <fieldset className="field fieldset-segmented">
                  <legend>任务类型</legend>
                  <div className="segmented-control">
                    <label><input type="radio" name="task-type" value="advertiser_product_taxonomy" checked={taskType === "advertiser_product_taxonomy"} onChange={() => { setTaskType("advertiser_product_taxonomy"); setAllowedRiskCategories([]); setSearchPlatforms([...searchPlatformIds]); }} /><span>广告品类标注</span></label>
                    <label><input type="radio" name="task-type" value="content_moderation" checked={taskType === "content_moderation"} onChange={() => { setTaskType("content_moderation"); setSearchPlatforms([]); }} /><span>内容审核</span></label>
                  </div>
                </fieldset>
                <fieldset className="field fieldset-segmented">
                  <legend>导出模式</legend>
                  <div className="segmented-control">
                    <label><input type="radio" name="export-mode" value="internal_research" checked={exportMode === "internal_research"} onChange={() => setExportMode("internal_research")} /><span>内部研发</span></label>
                    <label><input type="radio" name="export-mode" value="strict_compliance" checked={exportMode === "strict_compliance"} onChange={() => setExportMode("strict_compliance")} /><span>严格合规</span></label>
                  </div>
                </fieldset>
              </div>
              {taskType === "content_moderation" ? (
                <fieldset className="moderation-risk-picker">
                  <legend>允许检索的风险类别</legend>
                  <p>默认全不选。只有同时在本地设置关闭默认安全搜索，并在此明确勾选风险类别时，搜索提供方才会按受控规则降低过滤。</p>
                  <div>
                    {([
                      ["adult_content", "成人内容"],
                      ["graphic_violence", "血腥暴力"],
                      ["self_harm", "自伤"]
                    ] as const).map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="checkbox"
                          checked={allowedRiskCategories.includes(value)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setAllowedRiskCategories((prior) => checked
                              ? [...prior, value]
                              : prior.filter((category) => category !== value));
                          }}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <fieldset className="platform-picker" aria-describedby="platform-picker-help">
                <legend>平台定向（仅影响搜索）</legend>
                <div className="platform-picker__heading">
                  <p id="platform-picker-help">
                    <span>平台定向只会改变搜索，不会改变标签分类、标签路径或导出标签。</span>
                    <span>支持站点定向的来源会追加平台查询（当前为百度、SerpApi）；其他来源仍按原查询搜索。</span>
                    <span>每个平台仅追加一条基于主查询词和主风格的查询，不展开全部同义词组合。</span>
                  </p>
                  <div className="platform-picker__actions">
                    <button type="button" onClick={() => setSearchPlatforms([...searchPlatformIds])}>全选平台</button>
                    <button type="button" onClick={() => setSearchPlatforms([])}>清空平台</button>
                  </div>
                </div>
                <div className="platform-picker__options">
                  {searchPlatformIds.map((platform) => (
                    <label key={platform}>
                      <input
                        type="checkbox"
                        checked={searchPlatforms.includes(platform)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSearchPlatforms((prior) => {
                            const selected = new Set(prior);
                            if (checked) selected.add(platform);
                            else selected.delete(platform);
                            return searchPlatformIds.filter((candidate) => selected.has(candidate));
                          });
                        }}
                      />
                      <span>{searchPlatformLabels[platform]}</span>
                    </label>
                  ))}
                </div>
                <small>{searchPlatforms.length === 0 ? "未限定平台" : `已选择 ${searchPlatforms.length} 个平台`}</small>
              </fieldset>
            </section>

            <section className="form-section" aria-labelledby="taxonomy-section-title">
              <div className="form-section__heading">
                <span className="form-section__index" aria-hidden="true">02</span>
                <div><h3 id="taxonomy-section-title">标签输入</h3><p>每行一个路径，仅用于训练数据分类、审核和导出。</p></div>
              </div>
              <label className="field" htmlFor="label-paths">
                <span>标签路径</span>
                <textarea
                  id="label-paths"
                  aria-label="标签路径"
                  rows={5}
                  value={taxonomyText}
                  aria-invalid={visibleTaxonomyIssues.length > 0}
                  aria-describedby="label-paths-help"
                  onBlur={() => setTaxonomyTouched(true)}
                  onChange={(event) => {
                    setTaxonomyText(event.currentTarget.value);
                    setTaxonomyTouched(true);
                  }}
                  placeholder={"电商快销>3C及电器>影音电器>音箱\n电商快销>3C及电器>智能穿戴>智能手表"}
                />
                <small id="label-paths-help">系统会保留层级关系，并把每行末级作为训练标签；标签路径不会自动加入搜索词。</small>
              </label>
            </section>

            <section className="form-section" aria-labelledby="defaults-section-title">
              <div className="form-section__heading">
                <span className="form-section__index" aria-hidden="true">03</span>
                <div>
                  <h3 id="defaults-section-title">双语查询条件</h3>
                  <p>主查询词逐行对应标签路径；每行可用逗号填写同义词。</p>
                </div>
              </div>
              <div className="form-grid">
                <label className="field" htmlFor="zh-query-terms">
                  <span>中文主查询词</span>
                  <textarea ref={zhQueryTermsRef} id="zh-query-terms" aria-label="中文主查询词" aria-invalid={Boolean(zhQueryError)} aria-describedby={zhQueryError ? "zh-query-error" : "zh-query-help"} rows={5} value={zhQueryTermsText} onChange={(event) => setZhQueryTermsText(event.currentTarget.value)} placeholder={"监控摄像头, 安防摄像机\n音箱, 蓝牙音箱"} />
                  {zhQueryError
                    ? <small className="field-error" id="zh-query-error">{zhQueryError}</small>
                    : <small id="zh-query-help">百度等中文来源使用；与有效标签路径逐行对应。</small>}
                </label>
                <label className="field" htmlFor="en-query-terms">
                  <span>英文主查询词</span>
                  <textarea ref={enQueryTermsRef} id="en-query-terms" aria-label="英文主查询词" aria-invalid={Boolean(enQueryError)} aria-describedby={enQueryError ? "en-query-error" : "en-query-help"} rows={5} value={enQueryTermsText} onChange={(event) => setEnQueryTermsText(event.currentTarget.value)} placeholder={"security camera, surveillance camera\nspeaker, bluetooth speaker"} />
                  {enQueryError
                    ? <small className="field-error" id="en-query-error">{enQueryError}</small>
                    : <small id="en-query-help">非中国来源使用；与有效标签路径逐行对应。</small>}
                </label>
              </div>
              <div className="form-grid">
                <div className="form-stack">
                  <strong>中文查询限制</strong>
                  <label className="field" htmlFor="zh-styles">
                    <span>中文素材风格</span>
                    <textarea id="zh-styles" aria-label="中文素材风格" rows={2} value={zhStylesText} onChange={(event) => setZhStylesText(event.currentTarget.value)} placeholder="电商广告、商品展示" />
                  </label>
                  <label className="field" htmlFor="zh-required-terms">
                    <span>中文必须包含词</span>
                    <input id="zh-required-terms" aria-label="中文必须包含词" value={zhRequiredText} onChange={(event) => setZhRequiredText(event.currentTarget.value)} placeholder="品牌词、商品特征" />
                  </label>
                  <label className="field" htmlFor="zh-excluded-terms">
                    <span>中文排除词</span>
                    <input id="zh-excluded-terms" aria-label="中文排除词" value={zhExcludedText} onChange={(event) => setZhExcludedText(event.currentTarget.value)} placeholder="实拍、评测、教程" />
                  </label>
                </div>
                <div className="form-stack">
                  <strong>英文查询限制</strong>
                  <label className="field" htmlFor="en-styles">
                    <span>英文素材风格</span>
                    <textarea id="en-styles" aria-label="英文素材风格" rows={2} value={enStylesText} onChange={(event) => setEnStylesText(event.currentTarget.value)} placeholder="ecommerce advertisement, product showcase" />
                  </label>
                  <label className="field" htmlFor="en-required-terms">
                    <span>英文必须包含词</span>
                    <input id="en-required-terms" aria-label="英文必须包含词" value={enRequiredText} onChange={(event) => setEnRequiredText(event.currentTarget.value)} placeholder="brand, product feature" />
                  </label>
                  <label className="field" htmlFor="en-excluded-terms">
                    <span>英文排除词</span>
                    <input id="en-excluded-terms" aria-label="英文排除词" value={enExcludedText} onChange={(event) => setEnExcludedText(event.currentTarget.value)} placeholder="real photo, review, tutorial" />
                  </label>
                </div>
              </div>
              <div className="form-grid">
                <label className="field" htmlFor="target-count">
                  <span>目标素材数</span>
                  <input id="target-count" aria-label="目标素材数" type="number" min={1} max={1000} step={1} value={targetCount} onChange={(event) => setTargetCount(Number(event.currentTarget.value))} />
                  <small>每个标签计划选入的数据量。</small>
                </label>
                <label className="field" htmlFor="candidate-count">
                  <span>候选素材数</span>
                  <input id="candidate-count" aria-label="候选素材数" aria-invalid={Boolean(countError)} type="number" min={1} max={1000} step={1} value={candidateCount} onChange={(event) => setCandidateCount(Number(event.currentTarget.value))} />
                  <small>每个标签期望拉取的候选上限。</small>
                </label>
              </div>
            </section>
          </div>

          <div className="dialog__footer">
            <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
            <button className="button button--primary" type="submit" disabled={submitting}>
              {submitting ? "正在创建…" : "创建并进入工作台"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
