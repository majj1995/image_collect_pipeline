import { useEffect, useState } from "react";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import Inbox from "lucide-react/dist/esm/icons/inbox.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { Link } from "react-router-dom";
import type { Job } from "../../shared/contracts.js";
import { ApiError, useApi } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { CreateJobDialog } from "../features/jobs/CreateJobDialog.js";

const taskTypeNames: Record<Job["taskType"], string> = {
  advertiser_product_taxonomy: "广告品类标注",
  content_moderation: "内容审核"
};

const modeNames: Record<Job["exportMode"], string> = {
  strict_compliance: "严格合规",
  internal_research: "内部研发"
};

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function formatDate(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? "—" : dateTime.format(timestamp);
}

export function JobsPage() {
  const api = useApi();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void api.listJobs().then(
      ({ items }) => {
        if (!active) return;
        setJobs(items);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(reason instanceof ApiError ? reason.message : "无法读取采集任务。");
        setLoading(false);
      }
    );
    return () => { active = false; };
  }, [api]);

  return (
    <main className="page page--jobs">
      <div className="page-toolbar">
        <div>
          <p className="eyebrow">本地训练数据管线</p>
          <h1>采集任务</h1>
          <p className="page-description">按标签扩充广告素材，审核后生成可追溯的数据集。</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => setDialogOpen(true)}>
          <Plus aria-hidden="true" size={16} strokeWidth={1.9} />
          新建采集任务
        </button>
      </div>

      {error ? <div className="inline-notice inline-notice--error" role="alert">{error}</div> : null}

      <div className="data-table-scroll">
        <table className="data-table" aria-label="采集任务列表">
          <thead>
            <tr>
              <th scope="col">任务名称</th>
              <th scope="col">任务类型</th>
              <th scope="col">导出模式</th>
              <th scope="col">执行状态</th>
              <th scope="col" className="cell-number">候选数</th>
              <th scope="col" className="cell-number">已选数</th>
              <th scope="col">最后更新</th>
              <th scope="col" className="cell-action">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8}><div className="table-loading" role="status">正在读取任务…</div></td></tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="table-empty">
                    <Inbox aria-hidden="true" size={24} strokeWidth={1.6} />
                    <strong>还没有采集任务</strong>
                    <span>创建任务后，标签队列和采集进度会显示在这里。</span>
                  </div>
                </td>
              </tr>
            ) : jobs.map((job) => (
              <tr key={job.id}>
                <th scope="row"><Link className="job-link" to={`/jobs/${job.id}`}>{job.name}</Link></th>
                <td>{taskTypeNames[job.taskType]}</td>
                <td>{modeNames[job.exportMode]}</td>
                <td><StatusBadge status={job.status} /></td>
                <td className="cell-number" aria-label="候选统计将在工作台显示">—</td>
                <td className="cell-number" aria-label="已选统计将在工作台显示">—</td>
                <td><time dateTime={job.updatedAt}>{formatDate(job.updatedAt)}</time></td>
                <td className="cell-action">
                  <Link className="table-action" to={`/jobs/${job.id}`}>
                    进入工作台<ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.9} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialogOpen ? <CreateJobDialog onClose={() => setDialogOpen(false)} /> : null}
    </main>
  );
}
