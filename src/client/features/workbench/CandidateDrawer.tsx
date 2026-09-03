import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useState, type FormEvent } from "react";
import type { Candidate, LabelTarget, ProviderId, RightsBasis, TaskType } from "../../../shared/contracts.js";
import { sanitizePublicHttpUrl } from "../../../shared/public-url.js";

interface CandidateDrawerProps {
  candidate: Candidate;
  providerDisplayNames: ReadonlyMap<ProviderId, string>;
  labels: LabelTarget[];
  taskType: TaskType;
  activeLabelId: string;
  strictCompliance: boolean;
  onClose: () => void;
  onMoveLabel: (candidateId: string, labelId: string) => void;
  onSetLabels: (candidateId: string, labelIds: string[], primaryLabelId: string) => void;
  onSetRightsEvidence: (candidateId: string, rightsBasis: RightsBasis, rightsEvidence: string | null) => void;
  sensitive: boolean;
  revealed: boolean;
  onSetRevealed: (candidateId: string, revealed: boolean) => void;
}

const rightsLabels: Record<NonNullable<Candidate["rightsStatus"]>, string> = {
  unknown: "授权未知", provider_claimed: "提供方声明", verified: "已核验许可", user_owned: "用户自有", cc0: "CC0", pdm: "公共领域"
};

const rightsBasisLabels: Record<RightsBasis, string> = {
  unknown: "未设置",
  verified_cc0: "已核验 CC0",
  verified_pdm: "已核验公共领域",
  cc0: "CC0",
  pdm: "公共领域",
  user_owned: "自有素材",
  licensed: "已获商业授权"
};

function isAuditEvidenceUrl(value: string): boolean {
  if (!value || value.length > 300) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function CandidateDrawer({ candidate, providerDisplayNames, labels, taskType, activeLabelId, strictCompliance, onClose, onMoveLabel, onSetLabels, onSetRightsEvidence, sensitive, revealed, onSetRevealed }: CandidateDrawerProps) {
  const title = candidate.title ?? candidate.id;
  const landingPage = sanitizePublicHttpUrl(candidate.landingPageUrl);
  const savedRightsEvidence = candidate.rightsEvidence && isAuditEvidenceUrl(candidate.rightsEvidence) ? candidate.rightsEvidence : null;
  const [rightsBasis, setRightsBasis] = useState<RightsBasis>(candidate.rightsBasis ?? "unknown");
  const [rightsEvidence, setRightsEvidence] = useState(candidate.rightsEvidence ?? "");
  const [rightsError, setRightsError] = useState<string | null>(null);
  useEffect(() => {
    setRightsBasis(candidate.rightsBasis ?? "unknown");
    setRightsEvidence(candidate.rightsEvidence ?? "");
    setRightsError(null);
  }, [candidate.id, candidate.rightsBasis, candidate.rightsEvidence]);
  const currentLabel = labels.find((label) => label.id === (candidate.primaryLabelId ?? activeLabelId));
  const currentParent = currentLabel?.path.slice(0, -1).join("\u0000");
  const moveOptions = taskType === "content_moderation" ? labels : labels.filter((label) => currentParent !== undefined && label.path.slice(0, -1).join("\u0000") === currentParent);
  const selectedLabelIds = [...new Set(candidate.labelIds ?? [])];
  const primaryLabelId = candidate.primaryLabelId && selectedLabelIds.includes(candidate.primaryLabelId)
    ? candidate.primaryLabelId
    : selectedLabelIds[0] ?? null;
  const setModerationLabel = (labelId: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...selectedLabelIds, labelId])]
      : selectedLabelIds.filter((item) => item !== labelId);
    if (!next.length) return;
    const nextPrimary = primaryLabelId && next.includes(primaryLabelId) ? primaryLabelId : next[0]!;
    onSetLabels(candidate.id, next, nextPrimary);
  };
  const saveRightsEvidence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const evidence = rightsEvidence.trim();
    if (rightsBasis === "unknown" || !isAuditEvidenceUrl(evidence)) {
      setRightsError("请选择具体依据并填写不含查询参数的 HTTP(S) 证据地址。");
      return;
    }
    setRightsError(null);
    onSetRightsEvidence(candidate.id, rightsBasis, evidence);
  };
  const clearRightsEvidence = () => {
    setRightsBasis("unknown");
    setRightsEvidence("");
    setRightsError(null);
    onSetRightsEvidence(candidate.id, "unknown", null);
  };
  return (
    <aside className="candidate-drawer" aria-label="素材溯源与信息">
      <div className="candidate-drawer__header">
        <div><h2>素材溯源与信息</h2><p>{title}</p></div>
        <button className="icon-button" type="button" aria-label="关闭素材详情" onClick={onClose}><X aria-hidden="true" size={18} /></button>
      </div>
      {candidate.pipelineState === "processed" && candidate.assetId ? <div className="candidate-drawer__media">
        <img className={`candidate-drawer__thumb${sensitive && !revealed ? " is-sensitive-hidden" : ""}`} src={`/api/media/${encodeURIComponent(candidate.assetId)}/thumbnail`} alt={sensitive && !revealed ? "" : `${title} 本地缩略图`} />
        {sensitive ? <button type="button" aria-label={`${revealed ? "隐藏" : "显示"}敏感图片详情 ${title}`} aria-pressed={revealed} onClick={() => onSetRevealed(candidate.id, !revealed)}>{revealed ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={16} />}{revealed ? "重新模糊" : "显示敏感图片"}</button> : null}
      </div> : null}
      <section className="candidate-drawer__section" aria-labelledby="source-rights-title">
        <h3 id="source-rights-title">来源与授权</h3>
        <dl>
          <div><dt>来源平台</dt><dd>{providerDisplayNames.get(candidate.provider) ?? candidate.provider}</dd></div>
          <div><dt>授权状态</dt><dd>{rightsLabels[candidate.rightsStatus ?? "unknown"]}</dd></div>
          <div><dt>权利依据</dt><dd>{candidate.rightsBasis ?? "unknown"}</dd></div>
          <div><dt>发现标签</dt><dd>{candidate.discoveryLabelIds?.join("、") || "—"}</dd></div>
        </dl>
        {landingPage ? <a className="candidate-drawer__link" href={landingPage} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={14} />打开来源页面</a> : <p className="candidate-drawer__muted">没有可安全公开的来源地址</p>}
      </section>
      <section className="candidate-drawer__section" aria-labelledby="provenance-title">
        <h3 id="provenance-title">发现链路（{candidate.provenance?.length ?? 0}）</h3>
        {candidate.provenance?.length ? <ol className="candidate-provenance">
          {candidate.provenance.map((entry) => {
            const entryLandingPage = sanitizePublicHttpUrl(entry.landingPageUrl);
            const entryImageUrl = sanitizePublicHttpUrl(entry.imageUrl);
            const entryLicenseUrl = sanitizePublicHttpUrl(entry.licenseUrl);
            return <li key={`${entry.queryRunId}:${entry.hitId}`}>
            <div className="candidate-provenance__heading"><strong>{providerDisplayNames.get(entry.provider) ?? entry.provider}</strong><span>{entry.variantName} · 第 {entry.page} 页</span></div>
            <dl>
              <div><dt>查询</dt><dd>{entry.query}</dd></div>
              <div><dt>来源</dt><dd>{[entry.sourceProvider, entry.source].filter(Boolean).join(" · ") || "—"}</dd></div>
              <div><dt>标题 / 创建者</dt><dd>{[entry.title, entry.creator].filter(Boolean).join(" · ") || "—"}</dd></div>
              <div><dt>许可声明</dt><dd>{entry.licenseName ?? rightsLabels[entry.rightsStatus]}</dd></div>
              <div><dt>审计 ID</dt><dd>{entry.queryRunId} · {entry.hitId}</dd></div>
            </dl>
            <div className="candidate-provenance__links">
              {entryLandingPage ? <a href={entryLandingPage} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={12} />来源页面</a> : null}
              {entryImageUrl ? <a href={entryImageUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={12} />图片地址</a> : null}
              {entryLicenseUrl ? <a href={entryLicenseUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={12} />许可证：{entry.licenseName ?? "证据页面"}</a> : null}
            </div>
          </li>;
          })}
        </ol> : <p className="candidate-drawer__muted">该候选尚无可展示的查询来源记录。</p>}
      </section>
      <section className="candidate-drawer__section" aria-labelledby="rights-evidence-title">
        <h3 id="rights-evidence-title">权利核验{strictCompliance ? " · 严格合规" : ""}</h3>
        <p className="candidate-drawer__muted">证据 URL 会写入本地审计记录；不接受带签名参数、账密或片段的地址。</p>
        <form className="rights-evidence-form" onSubmit={saveRightsEvidence}>
          <label htmlFor="candidate-rights-basis"><span>权利依据</span><select id="candidate-rights-basis" aria-label="权利依据" value={rightsBasis} onChange={(event) => setRightsBasis(event.currentTarget.value as RightsBasis)}>
            {Object.entries(rightsBasisLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label htmlFor="candidate-rights-evidence"><span>权利证据 URL</span><input id="candidate-rights-evidence" aria-label="权利证据 URL" type="url" maxLength={300} placeholder="https://rights.example/evidence/42" value={rightsEvidence} onChange={(event) => setRightsEvidence(event.currentTarget.value)} /></label>
          {rightsError ? <p className="rights-evidence-form__error" role="alert">{rightsError}</p> : null}
          <div className="rights-evidence-form__actions"><button type="submit">保存权利依据</button><button type="button" onClick={clearRightsEvidence}>清除权利依据</button></div>
        </form>
        {savedRightsEvidence ? <a className="candidate-drawer__link" href={savedRightsEvidence} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={14} />查看已保存证据</a> : null}
      </section>
      <section className="candidate-drawer__section" aria-labelledby="file-info-title">
        <h3 id="file-info-title">文件信息</h3>
        <dl>
          <div><dt>处理状态</dt><dd>{candidate.pipelineState}</dd></div>
          <div><dt>分辨率</dt><dd>{candidate.width && candidate.height ? `${candidate.width} × ${candidate.height}` : "待处理"}</dd></div>
          <div><dt>文件格式</dt><dd>{candidate.mimeType ?? "待识别"}</dd></div>
          <div><dt>审核状态</dt><dd>{candidate.reviewState ?? "unreviewed"}</dd></div>
        </dl>
      </section>
      <section className="candidate-drawer__section" aria-labelledby="label-move-title">
        <h3 id="label-move-title">最终标签</h3>
        {taskType === "content_moderation" ? <fieldset className="moderation-labels"><legend>内容审核标签</legend>
          <p>可分配多个标签；主标签始终保留在所选集合中。</p>
          <div>{labels.map((label) => {
            const path = label.path.join(" / ");
            const checked = selectedLabelIds.includes(label.id);
            return <div className="moderation-labels__row" key={label.id}>
              <label><input type="checkbox" aria-label={`分配标签 ${path}`} checked={checked} disabled={checked && selectedLabelIds.length === 1} onChange={(event) => setModerationLabel(label.id, event.currentTarget.checked)} /><span>{path}</span></label>
              <label className="moderation-labels__primary"><input type="radio" name={`primary-${candidate.id}`} aria-label={`设为主标签 ${path}`} checked={primaryLabelId === label.id} disabled={!checked} onChange={() => { if (checked) onSetLabels(candidate.id, selectedLabelIds, label.id); }} /><span>主标签</span></label>
            </div>;
          })}</div>
        </fieldset> : <label className="field" htmlFor="candidate-label-move">
          <span>移动到标签</span>
          <select id="candidate-label-move" aria-label="移动到标签" value={candidate.primaryLabelId ?? ""} onChange={(event) => onMoveLabel(candidate.id, event.currentTarget.value)}>
            <option value="" disabled>选择兄弟标签</option>
            {moveOptions.map((label) => <option key={label.id} value={label.id}>{label.path.join(" / ")}</option>)}
          </select>
        </label>}
      </section>
      {candidate.warnings?.length ? <section className="candidate-drawer__section"><h3>校验信息</h3><ul className="candidate-drawer__warnings">{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section> : null}
    </aside>
  );
}
