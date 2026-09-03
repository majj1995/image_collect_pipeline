import { useEffect, useState } from "react";
import FolderTree from "lucide-react/dist/esm/icons/folder-tree.mjs";
import { Link, useParams } from "react-router-dom";
import { ApiError, useApi, type JobDetail } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function JobPlaceholderPage() {
  const { jobId = "" } = useParams();
  const api = useApi();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getJob(jobId).then(
      (value) => { if (active) setJob(value); },
      (reason: unknown) => { if (active) setError(reason instanceof ApiError ? reason.message : "无法读取任务。"); }
    );
    return () => { active = false; };
  }, [api, jobId]);

  if (error) {
    return <main className="page"><div className="inline-notice inline-notice--error" role="alert">{error}</div></main>;
  }
  if (!job) {
    return <main className="page"><div className="page-loading" role="status">正在打开任务…</div></main>;
  }

  return (
    <main className="page page--job-placeholder">
      <Link className="back-link" to="/">返回采集任务</Link>
      <div className="job-heading">
        <div>
          <p className="eyebrow">任务工作台</p>
          <h1>{job.name}</h1>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <section className="label-preview" aria-labelledby="label-preview-title">
        <div className="label-preview__heading">
          <FolderTree aria-hidden="true" size={18} strokeWidth={1.7} />
          <h2 id="label-preview-title">分类队列</h2>
        </div>
        <ul>
          {job.labels.map((label) => <li key={label.id}>{label.path.join(" / ")}</li>)}
        </ul>
        <p>素材采集与审核区域将在任务工作台阶段接入。</p>
      </section>
    </main>
  );
}
