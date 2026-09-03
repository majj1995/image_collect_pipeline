import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.mjs";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check.mjs";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed.mjs";
import type { Job } from "../../shared/contracts.js";

export type StatusKind = Job["status"] | "connecting" | "connected" | "disconnected";

const statusMeta: Record<StatusKind, { label: string; tone: string; icon: typeof CircleCheck }> = {
  connecting: { label: "正在连接本地服务", tone: "neutral", icon: CircleDashed },
  connected: { label: "本地服务已连接", tone: "success", icon: CircleCheck },
  disconnected: { label: "本地服务未连接", tone: "danger", icon: CircleAlert },
  draft: { label: "待开始", tone: "neutral", icon: CircleDashed },
  collecting: { label: "采集中", tone: "info", icon: CircleDashed },
  reviewing: { label: "审核中", tone: "warning", icon: CircleDashed },
  ready: { label: "可导出", tone: "success", icon: CircleCheck },
  failed: { label: "执行失败", tone: "danger", icon: CircleAlert }
};

export function StatusBadge({ status, label }: { status: StatusKind; label?: string }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`status-badge status-badge--${meta.tone}`} data-status={status}>
      <Icon aria-hidden="true" size={13} strokeWidth={1.9} />
      {label ?? meta.label}
    </span>
  );
}
