import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useState, type MouseEvent } from "react";
import { isRetryableDownloadFailureCode, type Candidate, type RetryableDownloadFailureCode } from "../../../shared/contracts.js";

interface CandidateCardProps {
  candidate: Candidate;
  providerDisplayName: string;
  checked: boolean;
  duplicateCount: number;
  duplicateExpanded: boolean;
  onToggleChecked: (candidateId: string) => void;
  onSelect: (candidateId: string, shiftKey: boolean) => void;
  onReject: (candidateId: string, shiftKey: boolean) => void;
  onOpen: (candidateId: string) => void;
  onToggleDuplicate: (groupId: string) => void;
  onKeepHighestResolution: (groupId: string) => void;
  sensitive: boolean;
  revealed: boolean;
  onSetRevealed: (candidateId: string, revealed: boolean) => void;
}

function dimensions(candidate: Candidate): string {
  return candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : "尺寸待处理";
}

const retryableDownloadCopy: Record<RetryableDownloadFailureCode, { title: string; detail: string }> = {
  FORBIDDEN: { title: "下载被来源拒绝", detail: "该来源当前拒绝图片下载，请更换来源后继续搜索" },
  RATE_LIMITED: { title: "下载受限", detail: "来源请求过于频繁，请稍后继续搜索" },
  NETWORK: { title: "下载未完成", detail: "网络连接异常，请稍后继续搜索" },
  GENERIC: { title: "下载未完成", detail: "来源暂时无法提供图片，请稍后继续搜索" }
};

function thumbnailFallback() {
  return <div className="candidate-card__placeholder candidate-card__placeholder--invalid"><ShieldAlert aria-hidden="true" size={22} /><strong>本地缩略图不可用</strong><span>请刷新任务或继续搜索重新生成</span></div>;
}

function pipelinePlaceholder(candidate: Candidate) {
  const title = candidate.title ?? candidate.id;
  if (candidate.pipelineState === "invalid") return <div className="candidate-card__placeholder candidate-card__placeholder--invalid"><ShieldAlert aria-hidden="true" size={22} /><strong>素材无效</strong><span>{candidate.pipelineError ?? "文件未通过校验"}</span></div>;
  if (candidate.pipelineState === "quarantined") return <div className="candidate-card__placeholder candidate-card__placeholder--quarantined"><ShieldAlert aria-hidden="true" size={22} /><strong>素材已隔离</strong><span>{candidate.pipelineError ?? "来源地址不安全"}</span></div>;
  if (candidate.pipelineError === "RETRYABLE_DOWNLOAD") {
    const copy = isRetryableDownloadFailureCode(candidate.pipelineFailureCode)
      ? retryableDownloadCopy[candidate.pipelineFailureCode]
      : retryableDownloadCopy.GENERIC;
    return <div className="candidate-card__placeholder candidate-card__placeholder--invalid"><ShieldAlert aria-hidden="true" size={22} /><strong>{copy.title}</strong><span>{copy.detail}</span></div>;
  }
  return <div className="candidate-card__placeholder candidate-card__placeholder--loading" role="status" aria-label={`${title} 正在处理`}><span className="candidate-card__skeleton" /><strong>{candidate.pipelineState === "fetching" ? "正在安全处理" : "等待本地处理"}</strong></div>;
}

export function CandidateCard(props: CandidateCardProps) {
  const { candidate, providerDisplayName, checked, duplicateCount, duplicateExpanded, onToggleChecked, onSelect, onReject, onOpen, onToggleDuplicate, onKeepHighestResolution, sensitive, revealed, onSetRevealed } = props;
  const title = candidate.title ?? candidate.id;
  const reviewState = candidate.reviewState ?? "unreviewed";
  const processed = candidate.pipelineState === "processed" && Boolean(candidate.assetId);
  const [failedAssetId, setFailedAssetId] = useState<string | null>(null);
  const groupId = candidate.nearDuplicateGroup;
  const handleSelect = (event: MouseEvent<HTMLButtonElement>) => onSelect(candidate.id, event.shiftKey);
  const handleReject = (event: MouseEvent<HTMLButtonElement>) => onReject(candidate.id, event.shiftKey);

  useEffect(() => {
    if (failedAssetId !== null && candidate.assetId !== null && candidate.assetId !== undefined && failedAssetId !== candidate.assetId) setFailedAssetId(null);
  }, [candidate.assetId, failedAssetId]);

  const thumbnailFailed = processed && failedAssetId === candidate.assetId;

  return (
    <article
      className={`candidate-card candidate-card--${reviewState} candidate-card--${candidate.pipelineState}`}
      data-testid={`candidate-${candidate.id}`}
      data-review-state={reviewState}
    >
      <div className="candidate-card__media">
        <label className="candidate-card__check">
          <input type="checkbox" checked={checked} aria-label={`勾选${title}`} onChange={() => onToggleChecked(candidate.id)} />
          <span aria-hidden="true"><Check size={13} strokeWidth={2.2} /></span>
        </label>
        {processed ? thumbnailFailed ? thumbnailFallback() : <>
          <img className={sensitive && !revealed ? "is-sensitive-hidden" : undefined} src={`/api/media/${encodeURIComponent(candidate.assetId!)}/thumbnail`} alt={sensitive && !revealed ? "" : `候选${title}`} loading="lazy" onError={() => setFailedAssetId(candidate.assetId!)} />
          {sensitive ? <button
            className={`candidate-card__sensitive-toggle${revealed ? " candidate-card__sensitive-toggle--revealed" : ""}`}
            type="button"
            aria-label={`${revealed ? "隐藏" : "显示"}敏感图片 ${title}`}
            aria-pressed={revealed}
            onClick={() => onSetRevealed(candidate.id, !revealed)}
          >{revealed ? <EyeOff aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={17} />}<span>{revealed ? "重新模糊" : "点击显示敏感图片"}</span></button> : null}
        </> : pipelinePlaceholder(candidate)}
        {reviewState !== "unreviewed" ? <span className={`candidate-card__review candidate-card__review--${reviewState}`}>{reviewState === "selected" ? "已选" : "已拒绝"}</span> : null}
      </div>
      <div className="candidate-card__meta">
        <button className="candidate-card__title" type="button" aria-label={`打开${title}`} onClick={() => onOpen(candidate.id)}>{title}</button>
        <span>{dimensions(candidate)} · {candidate.mimeType?.replace("image/", "").toUpperCase() ?? "待识别"}</span>
        <span className="candidate-card__source">{providerDisplayName} · {candidate.rightsStatus === "unknown" ? "授权未知" : candidate.rightsStatus?.toUpperCase()}</span>
      </div>
      {groupId && duplicateCount > 1 ? (
        <div className="candidate-card__duplicate">
          <button type="button" aria-label={`${duplicateExpanded ? "收起" : "展开"}重复素材 ${duplicateCount} 项`} onClick={() => onToggleDuplicate(groupId)}>
            重复组 {duplicateCount}<ChevronDown aria-hidden="true" size={13} className={duplicateExpanded ? "is-open" : ""} />
          </button>
          <button type="button" aria-label="保留重复组最高分辨率" onClick={() => onKeepHighestResolution(groupId)}>保留最高分辨率</button>
        </div>
      ) : null}
      <div className="candidate-card__actions">
        <button type="button" aria-label={`选择${title}`} disabled={!processed} onClick={handleSelect}><Check aria-hidden="true" size={15} />选择</button>
        <button type="button" aria-label={`拒绝${title}`} onClick={handleReject}><X aria-hidden="true" size={15} />拒绝</button>
        <button type="button" aria-label={`查看${title} 详情`} onClick={() => onOpen(candidate.id)}><Eye aria-hidden="true" size={15} />详情</button>
      </div>
    </article>
  );
}
