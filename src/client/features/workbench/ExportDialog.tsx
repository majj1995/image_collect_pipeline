import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import CheckCircle from "lucide-react/dist/esm/icons/circle-check.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Lock from "lucide-react/dist/esm/icons/lock.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useRef, useState } from "react";
import { ApiError, useApi, type ExportPreflight, type ExportStatus, type JobDetail } from "../../api.js";
import { useModalFocus } from "./useModalFocus.js";

interface ExportDialogProps {
  job: JobDetail;
  open: boolean;
  onClose: () => void;
}

const acknowledgementText = "我已确认这些素材仅用于内部研发，并理解授权状态未知";
const count = (preflight: ExportPreflight, ...codes: string[]) => codes.reduce((total, code) => total + (preflight.blockers[code]?.length ?? 0), 0);

function automaticDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.hidden = true;
  link.click();
}

export function ExportDialog({ job, open, onClose }: ExportDialogProps) {
  const api = useApi();
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [record, setRecord] = useState<ExportStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userInitiatedRef = useRef(false);
  const autoDownloadedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalFocus(open, onClose, dialogRef, closeButtonRef);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreflight(null); setAcknowledged(false); setRecord(null); setError(null); setLoading(false);
    userInitiatedRef.current = false; autoDownloadedRef.current = false;
    void api.getExportPreflight(job.id).then(
      (value) => { if (active) setPreflight(value); },
      (reason: unknown) => { if (active) setError(reason instanceof ApiError ? reason.message : "无法读取导出预检。" ); }
    );
    return () => { active = false; };
  }, [api, job.id, open]);

  useEffect(() => {
    if (!open || record?.status !== "generating") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api.getExport(record.id);
        if (!active) return;
        setRecord(next);
        if (next.status === "ready") {
          if (userInitiatedRef.current && !autoDownloadedRef.current) {
            autoDownloadedRef.current = true;
            automaticDownload(api.exportDownloadUrl(next.id));
          }
          return;
        }
        if (next.status === "failed") { setError("ZIP 生成失败，请检查素材后重试。"); return; }
        timer = setTimeout(() => { void poll(); }, 1200);
      } catch (reason) {
        if (active) setError(reason instanceof ApiError ? reason.message : "无法读取导出进度。" );
      }
    };
    timer = setTimeout(() => { void poll(); }, 1200);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, open, record?.id, record?.status]);

  if (!open) return null;
  const acknowledgementIds = preflight?.blockers.ACKNOWLEDGEMENT_REQUIRED ?? [];
  const nonAcknowledgementBlockers = preflight ? Object.keys(preflight.blockers).filter((code) => code !== "ACKNOWLEDGEMENT_REQUIRED" && preflight.blockers[code]!.length > 0) : [];
  const needsAcknowledgement = job.exportMode === "internal_research" && acknowledgementIds.length > 0;
  const canGenerate = Boolean(preflight && preflight.selected > 0 && nonAcknowledgementBlockers.length === 0 && (!needsAcknowledgement || acknowledged) && !loading && record?.status !== "generating");

  const generate = async () => {
    if (!preflight || !canGenerate) return;
    setLoading(true); setError(null); userInitiatedRef.current = true;
    try {
      if (needsAcknowledgement) {
        await api.review(job.id, { candidateIds: acknowledgementIds, action: "acknowledge_rights", rightsAcknowledged: true });
      }
      const checked = await api.getExportPreflight(job.id);
      setPreflight(checked);
      if (Object.keys(checked.blockers).some((code) => checked.blockers[code]!.length > 0)) {
        setError("预检仍有阻塞项，尚未创建 ZIP。");
        return;
      }
      if (checked.selected === 0) {
        setError("没有可导出的已选素材，尚未创建 ZIP。");
        return;
      }
      const created = await api.createExport(job.id);
      const next: ExportStatus = { ...created, jobId: job.id, errorCode: null, zipSha256: null };
      setRecord(next);
      if (created.status === "ready" && !autoDownloadedRef.current) {
        autoDownloadedRef.current = true;
        automaticDownload(api.exportDownloadUrl(created.id));
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "导出请求失败，请重试。" );
    } finally { setLoading(false); }
  };

  const readyUrl = record?.status === "ready" ? api.exportDownloadUrl(record.id) : null;
  return (
    <div className="dialog-backdrop export-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1}>
        <div className="dialog__header">
          <div><h2 id="export-title">导出数据集</h2><p>生成前核对素材、标签与授权状态。</p></div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭导出数据集" onClick={onClose}><X aria-hidden="true" size={18} /></button>
        </div>
        <div className="export-dialog__body">
          <div className="export-mode" role="radiogroup" aria-label="导出模式">
            <label className={job.exportMode === "strict_compliance" ? "is-active" : ""}><input type="radio" checked={job.exportMode === "strict_compliance"} readOnly disabled={job.exportMode !== "strict_compliance"} /><ShieldCheck aria-hidden="true" size={20} /><span><strong>严格合规</strong><small>仅导出完全合规的素材</small></span></label>
            <label className={job.exportMode === "internal_research" ? "is-active" : ""}><input type="radio" checked={job.exportMode === "internal_research"} readOnly disabled={job.exportMode !== "internal_research"} /><Lock aria-hidden="true" size={20} /><span><strong>内部研发</strong><small>允许确认授权未知项</small></span></label>
          </div>
          {!preflight && !error ? <div className="export-loading" role="status">正在执行导出预检…</div> : null}
          {preflight ? <section className="export-audit" aria-labelledby="export-audit-title">
            <h3 id="export-audit-title">导出审计</h3>
            <dl>
              <div><dt>已选素材</dt><dd>{preflight.selected} 条</dd></div>
              <div className="is-success"><dt><CheckCircle aria-hidden="true" size={16} />可导出</dt><dd>{preflight.ready} 条</dd></div>
              <div className={count(preflight, "ACKNOWLEDGEMENT_REQUIRED", "RIGHTS_UNVERIFIED") ? "is-warning" : ""}><dt>授权未知</dt><dd>{count(preflight, "ACKNOWLEDGEMENT_REQUIRED", "RIGHTS_UNVERIFIED")} 条</dd></div>
              <div className={count(preflight, "PROVIDER_STORAGE_RIGHTS_REQUIRED") ? "is-danger" : ""}><dt>提供方合约阻塞</dt><dd>{count(preflight, "PROVIDER_STORAGE_RIGHTS_REQUIRED")} 条</dd></div>
              <div className={count(preflight, "LABEL_CONFLICT") ? "is-danger" : ""}><dt>标签冲突</dt><dd>{count(preflight, "LABEL_CONFLICT")} 条</dd></div>
              <div className={count(preflight, "ASSET_MISSING", "ASSET_CHANGED", "QUARANTINED") ? "is-danger" : ""}><dt>素材缺失</dt><dd>{count(preflight, "ASSET_MISSING", "ASSET_CHANGED", "QUARANTINED")} 条</dd></div>
            </dl>
          </section> : null}
          {preflight && Object.keys(preflight.blockers).length ? <div className="export-blocker"><AlertTriangle aria-hidden="true" size={18} /><div><strong>包含阻塞项</strong><p>{nonAcknowledgementBlockers.includes("PROVIDER_STORAGE_RIGHTS_REQUIRED") ? "提供方合约阻塞不能通过内部研发确认绕过，请先完成服务端权利声明。" : job.exportMode === "strict_compliance" ? "严格合规模式不提供授权确认绕过，请补充有效权利依据。" : "确认后仅解除授权未知项，其余阻塞仍需先处理。"}</p></div></div> : null}
          {needsAcknowledgement ? <label className="export-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} /><span>{acknowledgementText}</span></label> : null}
          {error ? <div className="inline-notice inline-notice--error" role="alert">{error}</div> : null}
          {record?.status === "generating" ? <div className="export-generation" role="status">正在生成 ZIP，请保持页面打开…</div> : null}
          {readyUrl ? <div className="export-ready" role="status"><CheckCircle aria-hidden="true" size={18} /><span>ZIP 已生成</span><a href={readyUrl} download aria-label="重新下载 ZIP"><Download aria-hidden="true" size={15} />重新下载 ZIP</a></div> : null}
        </div>
        <div className="dialog__footer">
          <button className="button button--secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button--primary" type="button" disabled={!canGenerate} onClick={() => { void generate(); }}>{loading ? "正在提交…" : "生成 ZIP"}</button>
        </div>
      </div>
    </div>
  );
}
