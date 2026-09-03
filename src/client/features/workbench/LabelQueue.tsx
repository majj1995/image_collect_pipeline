import type { LabelTarget } from "../../../shared/contracts.js";

interface LabelQueueProps {
  labels: LabelTarget[];
  activeLabelId: string;
  candidateCounts: ReadonlyMap<string, number>;
  selectedCounts: ReadonlyMap<string, number>;
  onSelect: (labelId: string) => void;
}

export function LabelQueue({ labels, activeLabelId, candidateCounts, selectedCounts, onSelect }: LabelQueueProps) {
  return (
    <nav className="label-queue" aria-label="分类队列">
      <div className="label-queue__heading">
        <h2>分类队列</h2>
        <span>{labels.length} 个叶子</span>
      </div>
      <div className="label-queue__list">
        {labels.map((label) => {
          const active = label.id === activeLabelId;
          const candidateCount = candidateCounts.get(label.id) ?? 0;
          const selectedCount = selectedCounts.get(label.id) ?? label.selectedCount;
          return (
            <button
              key={label.id}
              className={`label-queue__item${active ? " label-queue__item--active" : ""}`}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(label.id)}
            >
              <span className="label-queue__path">{label.path.join(" / ")}</span>
              <span className="label-queue__counts"><strong>{selectedCount}</strong> 已选 · {candidateCount} 候选</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
